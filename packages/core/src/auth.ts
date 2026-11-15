/**
 * Sessions & personas: which account each filmed page is signed in as, where a persona's session lives, what a
 * sign-in page looks like. Pure (no browser, no file access); shared by the validation, the runner and the CLI.
 *
 * A persona's files are never written in project.yaml: they are derived under the Retake home —
 * `~/.retake` (RETAKE_HOME moves it) — as profiles/<project>/<env>/<persona>/ (the Chromium profile
 * `retake login` keeps), sessions/<project>/<env>/<persona>.json (the session snapshot) and
 * sessions/<project>/<env>/<persona>.status.json (the last check). The legacy single-account form (`auth.profile` /
 * `auth.storage_state`) keeps working as an implicit persona `default` signed into every page.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { isAbsoluteUrl, splitPageOpen } from './pages.js';
import { resolvePageUrl } from './templating.js';
import type { AuthConfig, LoginPattern, LoginStep, PersonaCheck, PersonaConfig } from './types/environment.js';
import type { LoadedProject, ProjectConfig } from './types/project.js';
import { LEGACY_PERSONA } from './persona-plan.js';
import { expandHome } from './util.js';

export { LEGACY_PERSONA, PERSONA_NONE, planPersonas } from './persona-plan.js';
export type { PersonaIssue, PersonaPlan, PlanPersonasOptions } from './persona-plan.js';

/** Keys of one auth block; any other key makes `auth` a map keyed by environment name. */
export const AUTH_KEYS: readonly string[] = ['profile', 'storage_state', 'login_url', 'personas'];
/** Default timeout of a persona check (seconds). */
export const PERSONA_CHECK_TIMEOUT_S = 10;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Whether `auth` is one block (global) rather than a map keyed by environment name. */
export function isGlobalAuth(auth: unknown): auth is AuthConfig {
  return isObject(auth) && Object.keys(auth).every((k) => AUTH_KEYS.includes(k));
}

/** The auth block of an environment: `auth` is global, or keyed by environment name. */
export function authFor(config: Pick<ProjectConfig, 'auth'>, env: string): AuthConfig | undefined {
  const a = config.auth;
  if (!isObject(a)) return undefined;
  if (isGlobalAuth(a)) return a;
  const v = Object.hasOwn(a, env) ? (a as Record<string, AuthConfig>)[env] : undefined;
  return isObject(v) ? v : undefined;
}

/**
 * The legacy single-account profile / storage state of an environment (`auth` global, or keyed by environment name),
 * as absolute paths (`~` expanded, relative to the project folder). Runs use personas (resolvePersonas: the legacy
 * form is persona "default"); kept for `retake login`, hooks and `retake doctor`.
 */
export function resolveAuth(project: Pick<LoadedProject, 'config' | 'dir'>, envName: string): { profileDir?: string; storageState?: string } {
  const cfg = authFor(project.config, envName);
  if (!cfg) return {};
  const inProject = (p: string): string => {
    const e = expandHome(p);
    return isAbsolute(e) ? e : resolve(project.dir, e);
  };
  return {
    profileDir: cfg.profile ? inProject(cfg.profile) : undefined,
    storageState: cfg.storage_state ? inProject(cfg.storage_state) : undefined,
  };
}

/** `wait_for_email {to: persona:<name>}`: the persona a recipient names, else null. */
export function mailPersona(to: string | undefined): string | null {
  const m = /^persona:\s*(\S+)\s*$/.exec(to ?? '');
  return m ? m[1] : null;
}

/** A persona's mail address on an environment (`auth.personas.<name>.email`; a sandbox account's username when it is one). */
export function personaEmail(config: Pick<ProjectConfig, 'auth'>, env: string, name: string): string | undefined {
  const p = authFor(config, env)?.personas;
  return isObject(p) && isObject(p[name]) ? (p[name] as PersonaConfig).email : undefined;
}

/** Every persona name the project declares, in any environment (the legacy form counts as `default`). */
export function projectPersonaNames(config: Pick<ProjectConfig, 'auth' | 'environments'>): string[] {
  const out = new Set<string>();
  const a = config.auth;
  if (!isObject(a)) return [];
  const blocks = isGlobalAuth(a) ? [a] : (Object.values(a).filter(isObject) as AuthConfig[]);
  for (const b of blocks) {
    if (b.profile !== undefined || b.storage_state !== undefined) out.add(LEGACY_PERSONA);
    if (isObject(b.personas)) for (const n of Object.keys(b.personas)) out.add(n);
  }
  return [...out];
}

/** A persona as a run uses it: its pages, check, sign-in patterns, login steps and the files of its session. */
export interface ResolvedPersona {
  name: string;
  env: string;
  /** The legacy single-account form (`auth.profile` / `auth.storage_state`): persona `default`, every page. */
  legacy: boolean;
  /** Environment page keys it is signed into by default. */
  pages: string[];
  session: 'profile' | 'storage_state';
  check?: PersonaCheck;
  /** Sign-in pages: auth.login_url, the persona's login_url and check.expect_not_url. */
  loginPatterns: LoginPattern[];
  login?: LoginStep[];
  /** The master profile `retake login` keeps (Chromium user-data-dir; a run only ever copies it). */
  profileDir?: string;
  /** The session snapshot (Playwright storage state + `retake` metadata). */
  snapshot?: string;
  /** The status of the last check (written by the preflight, `retake login`, `retake auth status --check`). */
  statusFile: string;
  /**
   * An account of a sandbox (`accounts:` of its sandbox.yaml): signed in by its login steps whenever its session is
   * missing (every take after a reset), which is expected rather than a warning.
   */
  sandbox?: true;
  /**
   * R-SBX-11: a sandbox account whose reset puts a Firebase Auth emulator's accounts back
   * (`reset.firebase_auth`) — the sandbox's state file, whose `accounts_at` says when: a session saved before that is
   * signed out (its ID token names accounts the emulator no longer has), so a take signs it in again off camera.
   */
  sandboxState?: string;
  /** Values its login steps type that are secrets as written (a sandbox account's plain password): masked like {{env:…}} values. */
  secrets?: string[];
}

/** Where a persona's files live under the Retake home. */
export function personaPaths(home: string, project: string, env: string, persona: string): { profileDir: string; snapshot: string; statusFile: string } {
  return {
    profileDir: join(home, 'profiles', project, env, persona),
    snapshot: join(home, 'sessions', project, env, `${persona}.json`),
    statusFile: join(home, 'sessions', project, env, `${persona}.status.json`),
  };
}

function asList<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function projectPath(dir: string, p: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(dir, e);
}

/** The personas of an environment (none when it declares no auth); on a sandbox, its accounts. */
export function resolvePersonas(project: Pick<LoadedProject, 'slug' | 'dir' | 'config'> & Partial<Pick<LoadedProject, 'sandboxes'>>, env: string, opts: { home: string }): ResolvedPersona[] {
  const auth = authFor(project.config, env);
  if (!auth) return [];
  const sandbox = project.sandboxes && Object.hasOwn(project.sandboxes, env) ? project.sandboxes[env] : undefined;
  const home = opts.home;
  const envPages = Object.keys(project.config.environments?.[env] ?? {});
  const common = asList(auth.login_url);
  if (auth.profile !== undefined || auth.storage_state !== undefined) {
    return [
      {
        name: LEGACY_PERSONA,
        env,
        legacy: true,
        pages: envPages,
        session: auth.profile !== undefined ? 'profile' : 'storage_state',
        loginPatterns: common,
        ...(auth.profile !== undefined ? { profileDir: projectPath(project.dir, auth.profile) } : {}),
        ...(auth.storage_state !== undefined ? { snapshot: projectPath(project.dir, auth.storage_state) } : {}),
        statusFile: personaPaths(home, project.slug, env, LEGACY_PERSONA).statusFile,
      },
    ];
  }
  return Object.entries(auth.personas ?? {}).map(([name, p]) => {
    const files = personaPaths(home, project.slug, env, name);
    const session = p.session ?? 'profile';
    return {
      name,
      env,
      legacy: false,
      pages: (p.pages ?? []).filter((k) => envPages.includes(k)),
      session,
      ...(p.check ? { check: p.check } : {}),
      loginPatterns: [...common, ...asList(p.login_url), ...asList(p.check?.expect_not_url)],
      ...(p.login?.length ? { login: p.login } : {}),
      ...(session === 'profile' ? { profileDir: files.profileDir } : {}),
      snapshot: files.snapshot,
      statusFile: files.statusFile,
      ...(sandbox ? { sandbox: true as const } : {}),
      ...(sandbox?.manifest.reset?.firebase_auth && sandbox.stateFile ? { sandboxState: sandbox.stateFile } : {}),
      ...(sandbox?.secrets[name]?.length ? { secrets: [...sandbox.secrets[name]] } : {}),
    };
  });
}

/** Sign-in pages of an environment's pages that have no persona (auth.login_url): they are guarded too. */
export function environmentLoginPatterns(config: Pick<ProjectConfig, 'auth'>, env: string): LoginPattern[] {
  return asList(authFor(config, env)?.login_url);
}

/**
 * The exact command that signs a persona in again. The legacy form has no `--persona`: callers leave `persona` out for it
 * (keyed on `legacy`, never on the name — a declared persona may be called "default").
 */
export function loginCommand(p: { project: string; env: string; persona?: string }): string {
  return `retake login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`;
}

// ── Sign-in pages ────────────────────────────────────────────────────────────

/** A compiled sign-in pattern: `test` takes a full URL and looks at its origin + path only. */
export interface LoginMatcher {
  /** The pattern as written (messages). */
  pattern: string;
  test(url: string): boolean;
}

/** The part of a URL a sign-in pattern sees, and the part messages show: origin + path, never the query or fragment. */
export function urlOriginPath(url: string): string {
  try {
    const u = new URL(url);
    if (u.origin === 'null') return `${u.protocol}${u.pathname}`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/**
 * Whether a URL is on the site of a sign-in pattern's base: same host — a leading "www." aside — and port, http or https
 * (an app that redirects http → https, or the apex domain → www, keeps its sign-in page).
 */
function sameSite(u: URL, base: URL): boolean {
  const host = (h: string) => h.toLowerCase().replace(/^www\./, '');
  return /^https?:$/.test(u.protocol) && /^https?:$/.test(base.protocol) && host(u.hostname) === host(base.hostname) && u.port === base.port;
}

/** A path prefix that stops at a segment boundary: "/sign-in" matches "/sign-in" and "/sign-in/x", not "/sign-in-help". */
function prefixMatches(value: string, prefix: string): boolean {
  const p = prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (p === '/' || p === '') return true;
  return value === p || value.startsWith(`${p}/`);
}

/** How a string sign-in pattern is read (validation names the same forms). */
export type LoginPatternForm = { kind: 'path'; path: string } | { kind: 'page'; page: string; path: string } | { kind: 'url'; url: URL } | { kind: 'invalid' };

export function loginPatternForm(pattern: string, envPages: readonly string[]): LoginPatternForm {
  if (pattern.startsWith('/')) return { kind: 'path', path: pattern };
  const split = splitPageOpen(pattern, envPages);
  if (split) return { kind: 'page', page: split.page, path: split.path };
  if (/^https?:\/\//i.test(pattern)) {
    try {
      return { kind: 'url', url: new URL(pattern) };
    } catch {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'invalid' };
}

/** Compile sign-in patterns against an environment's pages (invalid ones — reported by validation — are dropped). */
export function loginMatchers(patterns: readonly LoginPattern[], envPages: Record<string, string>): LoginMatcher[] {
  const out: LoginMatcher[] = [];
  const keys = Object.keys(envPages);
  for (const p of patterns) {
    if (typeof p !== 'string') {
      let re: RegExp;
      try {
        // `g` / `y` make test() stateful (lastIndex): refused by validation, never applied.
        re = new RegExp(p.regex, (p.flags ?? '').replace(/[gy]/g, ''));
      } catch {
        continue;
      }
      out.push({ pattern: `/${p.regex}/${p.flags ?? ''}`, test: (url) => re.test(urlOriginPath(url)) });
      continue;
    }
    const form = loginPatternForm(p, keys);
    if (form.kind === 'path') {
      out.push({
        pattern: p,
        test: (url) => {
          try {
            const u = new URL(url);
            return /^https?:$/.test(u.protocol) && prefixMatches(u.pathname, form.path);
          } catch {
            return false;
          }
        },
      });
    } else if (form.kind === 'page' || form.kind === 'url') {
      let base: URL;
      try {
        base = form.kind === 'url' ? form.url : new URL(resolvePageUrl(envPages[form.page], form.path));
      } catch {
        continue;
      }
      out.push({
        pattern: p,
        test: (url) => {
          try {
            const u = new URL(url);
            return (u.origin === base.origin || sameSite(u, base)) && prefixMatches(u.pathname, base.pathname);
          } catch {
            return false;
          }
        },
      });
    }
  }
  return out;
}

/** The first sign-in pattern a URL matches, else null. */
export function matchLoginUrl(url: string, matchers: readonly LoginMatcher[]): LoginMatcher | null {
  return matchers.find((m) => m.test(url)) ?? null;
}

/** The URL a persona's check opens: check.url resolved (default: its first page's "/"); null when nothing to open. */
export function resolveCheckUrl(persona: Pick<ResolvedPersona, 'check' | 'pages'>, envPages: Record<string, string>): string | null {
  const first = persona.pages[0] ?? Object.keys(envPages)[0];
  const base = first !== undefined ? envPages[first] : undefined;
  const u = persona.check?.url;
  if (u === undefined) return base !== undefined ? resolvePageUrl(base, '/') : null;
  const split = splitPageOpen(u, Object.keys(envPages));
  if (split) return resolvePageUrl(envPages[split.page], split.path);
  if (isAbsoluteUrl(u)) return u;
  return base !== undefined ? resolvePageUrl(base, u) : null;
}
