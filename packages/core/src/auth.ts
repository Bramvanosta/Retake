/**
 * Sessions & personas (L1.6): which account each filmed page is signed in as, where a persona's session lives, what a
 * sign-in page looks like. Pure (no browser, no file access); shared by the validation, the runner and the CLI.
 *
 * A persona's files are never written in project.yaml: they are derived under the Retake home —
 * `~/.retake` (RETAKE_HOME moves it) — as profiles/<project>/<env>/<persona>/ (the Chromium profile
 * `retake login` keeps), sessions/<project>/<env>/<persona>.json (the session snapshot) and
 * sessions/<project>/<env>/<persona>.status.json (the last check). The legacy single-account form (`auth.profile` /
 * `auth.storage_state`) keeps working as an implicit persona `default` signed into every page.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { formatPath } from './issues.js';
import type { IssuePath } from './issues.js';
import { isAbsoluteUrl, scenePageEntries, splitPageOpen } from './pages.js';
import { resolvePageUrl } from './templating.js';
import { isCaptureScene } from './types.js';
import type { AuthConfig, LoadedProject, LoginPattern, LoginStep, PersonaCheck, PersonaConfig, ProjectConfig, Scenario, Scene } from './types.js';
import { expandHome } from './util.js';

/** `persona: none` — a page filmed without any persona (a fresh browser, never guarded). */
export const PERSONA_NONE = 'none';
/** The implicit persona of the legacy `auth.profile` / `auth.storage_state` form. */
export const LEGACY_PERSONA = 'default';
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

/** `wait_for_email {to: persona:<name>}` (L5.6): the persona a recipient names, else null. */
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
   * An account of a sandbox (L1.8, `accounts:` of its sandbox.yaml): signed in by its login steps whenever its session is
   * missing (every take after a reset), which is expected rather than a warning.
   */
  sandbox?: true;
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

/** The personas of an environment (none when it declares no auth); on a sandbox, its accounts (L1.8). */
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

// ── Which persona films which page (static plan) ───────────────────────────────

/** A binding problem found by the plan, positioned in the scenario. */
export interface PersonaIssue {
  path: IssuePath;
  message: string;
  /** unknown: a persona the environment does not declare; placement: `persona` where it does not belong; conflict: a page asked for two personas. */
  kind: 'unknown' | 'placement' | 'conflict';
}

/** Which persona each page of a run is signed in as (core planPersonas). */
export interface PersonaPlan {
  /** Capture page id → persona (null: no persona, the run's default browser). */
  pages: Map<string, string | null>;
  /** Pages written `persona: none` (never guarded). */
  none: Set<string>;
  /** js hook tabs (environment page key) → persona. */
  hookPages: Map<string, string | null>;
  /** The personas the run signs in (checked by the preflight), in declaration order. */
  used: string[];
  /** The personas its http hooks act as (`auth: {persona}`): signed in like the filmed ones, each in its own browser. */
  hookAuth: string[];
  /** Some page or hook tab runs without a persona (the default browser is needed). */
  needsDefault: boolean;
  issues: PersonaIssue[];
}

export interface PlanPersonasOptions {
  env: string;
  /** The environment's pages (page key → base URL). */
  envPages: Record<string, string>;
  personas: readonly Pick<ResolvedPersona, 'name' | 'pages' | 'legacy'>[];
  /** The last step the run executes (`--until`): later scenes and steps are not walked. */
  until?: { sceneIndex: number; stepIndex: number } | null;
  /** Whether the setup / teardown hooks run (their js tabs need a persona too). */
  hooks: boolean;
  /** project.yaml's named hooks: the ones the scenario's `hook:` steps run may act as a persona (`auth: {persona}`). */
  projectHooks?: Record<string, unknown>;
}

/**
 * Bind every page a run films to a persona, the way the run walks the scenario: a single-page scene films `page`
 * (default: the previous scene's page, else the first environment page), `open: {page}` and `switch_page` move to a
 * page (`previous`: the page shown before, as the run's page history), `new_tab` opens a tab of the page it is on (same
 * persona — a tab of a `persona: none` page is never guarded either), a multi-page scene films each of its `pages`. A
 * page's persona is fixed the first time it is filmed: its `persona` (scene, or `pages.<id>.persona`), else the first
 * persona declared whose `pages` list its environment page (several may: one app, several roles), else the legacy `default` persona, else none; `persona: none` written later
 * on a page filmed without one leaves it unguarded. A page asked for another persona later is an error (it keeps one
 * for the whole run, like its viewport). A js hook tab takes the persona its page is filmed with, else its default.
 * Skipped scenes and what comes after `--until` are not walked. In an environment without personas nothing is bound
 * (`persona` keys are ignored).
 */
export function planPersonas(sc: Scenario, opts: PlanPersonasOptions): PersonaPlan {
  const plan: PersonaPlan = { pages: new Map(), none: new Set(), hookPages: new Map(), used: [], hookAuth: [], needsDefault: false, issues: [] };
  const envKeys = Object.keys(opts.envPages);
  const names = new Set(opts.personas.map((p) => p.name));
  const legacy = opts.personas.some((p) => p.legacy) ? LEGACY_PERSONA : null;
  if (opts.personas.length === 0) {
    plan.needsDefault = true;
    return plan;
  }
  const defaultOf = (envKey: string | undefined): string | null => {
    if (envKey !== undefined) {
      const p = opts.personas.find((x) => !x.legacy && x.pages.includes(envKey));
      if (p) return p.name;
    }
    return legacy;
  };
  const firstSite = new Map<string, IssuePath>();
  const declaredEnv = new Map<string, string>();
  const valid = (persona: string, path: IssuePath): boolean => {
    if (persona === PERSONA_NONE || names.has(persona)) return true;
    plan.issues.push({
      path,
      kind: 'unknown',
      message: `persona "${persona}" is not declared for environment "${opts.env}" (personas: ${[...names].join(', ')}; or ${PERSONA_NONE})`,
    });
    return false;
  };
  /** `inherit`: a tab takes the persona (and the `none`) of the page it is opened from; any other page its default. */
  const bind = (id: string, explicit: string | undefined, inherit: { persona: string | null; none: boolean } | { envKey: string | undefined }, path: IssuePath): void => {
    if (explicit !== undefined && !valid(explicit, path)) return;
    const want = explicit === undefined ? undefined : explicit === PERSONA_NONE ? null : explicit;
    if (plan.pages.has(id)) {
      const have = plan.pages.get(id) ?? null;
      if (want !== undefined && want !== have) {
        const where = firstSite.get(id);
        plan.issues.push({
          path,
          kind: 'conflict',
          message:
            `page "${id}" is filmed ${have === null ? 'without a persona' : `as ${have}`}${where ? ` since ${formatPath(where)}` : ''} and ` +
            `${want === null ? 'without one' : `as ${want}`} here: a page keeps one persona for the whole run — film the other account on a page id of its own (a multi-page scene's \`pages\`)`,
        });
      } else if (explicit === PERSONA_NONE) {
        // Filmed without a persona so far, written `persona: none` now: never guarded (a page keeps one binding).
        plan.none.add(id);
      }
      return;
    }
    const persona = want !== undefined ? want : 'persona' in inherit ? inherit.persona : defaultOf(inherit.envKey);
    plan.pages.set(id, persona);
    firstSite.set(id, path);
    if (explicit === PERSONA_NONE || (want === undefined && 'none' in inherit && inherit.none)) plan.none.add(id);
  };
  const envKeyOf = (id: string): string | undefined => (envKeys.includes(id) ? id : declaredEnv.get(id));
  const originKey = (url: string): string | undefined => {
    try {
      const o = new URL(url).origin;
      return envKeys.find((k) => {
        try {
          return new URL(opts.envPages[k]).origin === o;
        } catch {
          return false;
        }
      });
    } catch {
      return undefined;
    }
  };

  let current: string | undefined;
  let tabSeq = 1;
  // The page shown and the pages shown before it (the run's page history: `switch_page: previous`), closed ones aside.
  let shown: string | undefined;
  const history: string[] = [];
  const closed = new Set<string>();
  const show = (id: string): void => {
    if (shown !== undefined && shown !== id) history.push(shown);
    shown = id;
    closed.delete(id);
  };
  const previous = (): string | undefined => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i] !== shown && !closed.has(history[i])) return history[i];
    return undefined;
  };
  const last = opts.until ? opts.until.sceneIndex : sc.scenes.length - 1;
  for (let si = 0; si <= last && si < sc.scenes.length; si++) {
    const entry = sc.scenes[si];
    if (!isCaptureScene(entry) || entry.skip) continue;
    const scene = entry as Scene;
    const base: IssuePath = ['scenes', si];
    const stepCount = opts.until && opts.until.sceneIndex === si ? opts.until.stepIndex + 1 : (scene.steps ?? []).length;
    if (scene.pages !== undefined) {
      if (scene.persona !== undefined) {
        plan.issues.push({ path: [...base, 'persona'], kind: 'placement', message: 'a multi-page scene binds each page: write `persona` on the page (`pages.<id>.persona`)' });
      }
      const entries = scenePageEntries(scene.pages);
      for (const e of entries) {
        const s = e.spec;
        const split = typeof s.open === 'string' ? splitPageOpen(s.open, envKeys) : null;
        let envKey = s.page ?? (split ? split.page : (declaredEnv.get(e.id) ?? (envKeys.includes(e.id) ? e.id : undefined)));
        if (envKey === undefined && typeof s.open === 'string' && isAbsoluteUrl(s.open)) envKey = originKey(s.open);
        if (envKey !== undefined) declaredEnv.set(e.id, envKey);
        bind(e.id, s.persona, { envKey }, [...base, ...e.path, 'persona']);
      }
      current = entries[0]?.id ?? current;
      if (entries[0]) show(entries[0].id);
      for (const raw of (scene.steps ?? []).slice(0, stepCount)) {
        if (isObject(raw) && typeof raw.on === 'string' && entries.some((e) => e.id === raw.on)) show(raw.on);
      }
      continue;
    }
    const id = scene.page ?? current ?? envKeys[0];
    if (id === undefined) continue;
    bind(id, scene.persona, { envKey: envKeyOf(id) }, [...base, scene.persona !== undefined ? 'persona' : 'page']);
    current = id;
    show(id);
    (scene.steps ?? []).slice(0, stepCount).forEach((raw, j) => {
      if (!isObject(raw)) return;
      const sp: IssuePath = [...base, 'steps', j];
      if (raw.open !== undefined && isObject(raw.open) && typeof raw.open.page === 'string') {
        show(raw.open.page);
        bind(raw.open.page, undefined, { envKey: envKeyOf(raw.open.page) }, sp);
      } else if (raw.switch_page !== undefined) {
        const sw = raw.switch_page;
        const to = typeof sw === 'string' ? sw : isObject(sw) && typeof sw.to === 'string' ? sw.to : undefined;
        const target = to === 'previous' ? previous() : to === 'main' ? (envKeys[0] ?? to) : to;
        if (target === undefined) return;
        const from = shown;
        show(target);
        if (isObject(sw) && sw.close_current === true && from !== undefined && from !== target) closed.add(from);
        bind(target, undefined, { envKey: envKeyOf(target) }, sp);
      } else if (raw.new_tab !== undefined && shown !== undefined) {
        const as = isObject(raw.new_tab) && typeof raw.new_tab.as === 'string' ? raw.new_tab.as : undefined;
        let tab = as;
        if (tab === undefined) {
          do tab = `tab${++tabSeq}`;
          while (plan.pages.has(tab));
        }
        bind(tab, undefined, { persona: plan.pages.get(shown) ?? null, none: plan.none.has(shown) }, sp);
        show(tab);
      }
    });
  }

  if (opts.hooks) {
    // Named hooks (L5.8) too: a js one runs in the same kind of tab (a project.yaml hook's page takes its default).
    const named = Object.values(isObject(sc.hooks) ? sc.hooks : {}).flatMap((v) => (Array.isArray(v) ? v : [v]));
    for (const list of [sc.setup ?? [], sc.teardown ?? [], named]) {
      for (const h of list) {
        if (!isObject(h) || h.js === undefined) continue;
        const spec = h.js as unknown;
        const key = (isObject(spec) && typeof spec.page === 'string' ? spec.page : undefined) ?? envKeys[0];
        if (key === undefined || plan.hookPages.has(key)) continue;
        // The persona the scenes film that page with (none included), else its default: the hook sees what is filmed.
        plan.hookPages.set(key, plan.pages.has(key) ? (plan.pages.get(key) ?? null) : defaultOf(key));
      }
    }
  }
  const hookAuth = new Set<string>();
  if (opts.hooks) {
    // http hooks that act as a persona (`auth: {persona}`, their rollback's too): the scenario's, and project.yaml's
    // named hooks its `hook:` steps run.
    const scan = (list: unknown, path: IssuePath): void => {
      (Array.isArray(list) ? list : [list]).forEach((h, i) => {
        if (!isObject(h) || !isObject(h.http)) return;
        const at: IssuePath = Array.isArray(list) ? [...path, i, 'http'] : [...path, 'http'];
        for (const [req, rp] of [
          [h.http, at],
          [h.http.rollback, [...at, 'rollback']],
        ] as Array<[unknown, IssuePath]>) {
          const persona = isObject(req) && isObject(req.auth) ? req.auth.persona : undefined;
          if (typeof persona !== 'string') continue;
          if (names.has(persona)) hookAuth.add(persona);
          else
            plan.issues.push({ path: [...rp, 'auth', 'persona'], kind: 'unknown', message: `persona "${persona}" is not declared for environment "${opts.env}" (personas: ${[...names].join(', ')})` });
        }
      });
    };
    scan(sc.setup ?? [], ['setup']);
    scan(sc.teardown ?? [], ['teardown']);
    const own = isObject(sc.hooks) ? sc.hooks : {};
    for (const [name, v] of Object.entries(own)) scan(v, ['hooks', name]);
    if (opts.projectHooks) {
      const ran = new Set<string>();
      for (const entry of sc.scenes) {
        if (!isCaptureScene(entry) || entry.skip) continue;
        for (const raw of (entry as Scene).steps ?? []) if (isObject(raw) && typeof raw.hook === 'string') ran.add(raw.hook);
      }
      for (const name of ran) if (!Object.hasOwn(own, name) && Object.hasOwn(opts.projectHooks, name)) scan(opts.projectHooks[name], ['hooks', name]);
    }
  }
  plan.hookAuth = opts.personas.map((p) => p.name).filter((n) => hookAuth.has(n));
  const used = new Set<string>(hookAuth);
  for (const p of [...plan.pages.values(), ...plan.hookPages.values()]) {
    if (p === null) plan.needsDefault = true;
    else used.add(p);
  }
  if (plan.pages.size === 0) plan.needsDefault = true;
  plan.used = opts.personas.map((p) => p.name).filter((n) => used.has(n));
  return plan;
}
