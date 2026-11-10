import { AUTH_KEYS, PERSONA_NONE, isGlobalAuth, loginPatternForm } from '../auth.js';
import type { IssuePath } from '../issues.js';
import { splitPageOpen } from '../pages.js';
import { describeTarget } from '../targets.js';
import type { TargetSpec } from '../types.js';
import { suggestion } from '../validation/suggest.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';
import { checkTokens } from './tokens.js';
import type { TokenScope } from './tokens.js';

const LEGACY_KEYS = ['profile', 'storage_state'] as const;
/** A field whose literal text is a password (a login `type` into it should use a secret reference). */
const PASSWORD_FIELD = /pass(word|code|phrase)?\b|\bpin\b|secret/i;
/** Characters that suggest a regular expression written as a plain sign-in pattern (matched as a path prefix). */
const REGEX_CHARS = /[\^$\\()|*+[\]{}]/;

/** `profile` / `storage_state` written inside a persona: checked on the raw value (the schema only says "unknown key"). */
export function checkPersonaPaths(auth: unknown, ctx: CheckContext): void {
  if (!isObj(auth)) return;
  const blocks: Array<[IssuePath, unknown]> = isGlobalAuth(auth) ? [[['auth'], auth]] : Object.entries(auth).map(([env, b]) => [['auth', env], b]);
  for (const [path, b] of blocks) {
    if (!isObj(b) || !isObj(b.personas)) continue;
    for (const [name, p] of Object.entries(b.personas)) {
      if (!isObj(p)) continue;
      for (const k of LEGACY_KEYS) {
        if (p[k] === undefined) continue;
        ctx.error(
          [...path, 'personas', name, k],
          `a persona's session is never a path in project.yaml (it would only exist on this computer): \`retake login\` keeps it in ~/.retake/profiles/<project>/<env>/${name} ` +
            '(RETAKE_HOME moves it) — remove `' + k + '`' + (k === 'storage_state' ? ' and set `session: storage_state`' : ''),
        );
      }
    }
  }
}

/** URLs no sign-in pattern should match all of (a pattern that does would fail every run on its first page). */
const ANY_URLS = ['https://a.invalid/', 'http://b.invalid:8080/x/y'];

/** The environment page (key) a URL pattern covers entirely: same origin, its path at or above the page's base path. */
function coveredPage(url: URL, pages: Readonly<Record<string, string>>): string | undefined {
  const prefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return Object.keys(pages).find((k) => {
    try {
      const b = new URL(pages[k]);
      return b.origin === url.origin && (b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`).startsWith(prefix);
    } catch {
      return false;
    }
  });
}

/**
 * Sign-in patterns (auth.login_url, a persona's login_url / check.expect_not_url): well formed, and never one that
 * matches every page — "/", "<page>:" / "<page>:/", the URL of an environment page, a regular expression that matches
 * any URL — nor one that can never match: {regex: "^/…"} (tested against origin + path), flags g / y (stateful).
 */
function checkPatterns(v: unknown, path: IssuePath, pages: Readonly<Record<string, string>>, ctx: CheckContext): void {
  const envKeys = Object.keys(pages);
  const list = Array.isArray(v) ? v : [v];
  const everything = (pp: IssuePath, p: string, what: string) =>
    ctx.error(pp, `"${p}" matches ${what}: every run would stop on its first page as "landed on the sign-in page" — write the sign-in page's own path ("/sign-in")`);
  list.forEach((p, i) => {
    const pp = Array.isArray(v) ? [...path, i] : path;
    if (isObj(p) && typeof p.regex === 'string') {
      const flags = typeof p.flags === 'string' ? p.flags : '';
      let re: RegExp;
      try {
        re = new RegExp(p.regex, flags);
      } catch (e) {
        ctx.error([...pp, 'regex'], `invalid regular expression: ${(e as Error).message}`);
        return;
      }
      if (/[gy]/.test(flags)) {
        ctx.error([...pp, 'flags'], `flags "g" and "y" make a regular expression remember where it stopped (it would match one URL in two, or only at the start): leave them out`);
      } else if (ANY_URLS.every((u) => re.test(u))) {
        ctx.error([...pp, 'regex'], `/${p.regex}/${flags} matches any URL: every run would stop on its first page as "landed on the sign-in page"`);
      } else if (p.regex.startsWith('^/')) {
        ctx.warning([...pp, 'regex'], `/${p.regex}/ never matches: a sign-in regex is tested against the origin + path ("http://host/sign-in") — write "^https?://[^/]+/…", or leave out the "^"`);
      }
      return;
    }
    if (typeof p !== 'string') return;
    const form = loginPatternForm(p, envKeys);
    if (form.kind === 'invalid') {
      const prefix = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(p)?.[1];
      ctx.error(
        pp,
        prefix && !/^https?$/i.test(prefix)
          ? `"${prefix}:" is not an environment page${suggestion(prefix, [...envKeys])} (pages: ${envKeys.join(', ') || 'none'})`
          : `"${p}" is not a sign-in pattern: write a path ("/sign-in"), "<page>:<path>", an absolute URL or {regex: …}`,
      );
      return;
    }
    if (form.kind === 'path' && /^\/+$/.test(p)) return everything(pp, p, 'every page');
    if (form.kind === 'page' && /^\/*$/.test(form.path)) return everything(pp, p, `every page of "${form.page}"`);
    if (form.kind === 'url') {
      const covered = coveredPage(form.url, pages);
      if (covered !== undefined) return everything(pp, p, `every page of "${covered}" (${pages[covered]})`);
    }
    if (/[?#]/.test(p)) ctx.warning(pp, `"${p}": the query string and fragment of a URL are never matched (sign-in patterns look at its origin + path)`);
    else if (form.kind === 'path' && /^\/.+\/[gimsuy]{1,4}$/.test(p)) {
      ctx.warning(pp, `"${p}" is matched as a path prefix, not as a regular expression /…/flags: write {regex: "…", flags: "…"} for one`);
    } else if (form.kind === 'path' && REGEX_CHARS.test(p)) ctx.warning(pp, `"${p}" is matched as a path prefix, not as a regular expression: write {regex: "…"} for one`);
  });
}

/** Options of checkAuth beyond project.yaml's own `auth`. */
export interface AuthCheckOptions {
  /** The project's sandbox environments (L1.8): their personas come from the accounts of their sandbox.yaml. */
  sandboxes?: readonly string[];
  /**
   * The accounts of a sandbox.yaml (L1.8), checked as one global auth block: login steps may use {{account.username}} /
   * {{account.password}}, and a password typed as written is advised to use {{account.password}}.
   */
  accounts?: boolean;
}

/** A `type` into a password field with literal text: the password would sit in project.yaml. */
function literalPassword(step: Record<string, unknown>): boolean {
  const t = step.type;
  if (!isObj(t) || typeof t.text !== 'string' || t.text.includes('{{') || t.text === '') return false;
  const into = t.into as TargetSpec | undefined;
  if (into === undefined) return false;
  let desc: string;
  try {
    desc = describeTarget(into);
  } catch {
    return false;
  }
  return PASSWORD_FIELD.test(desc);
}

/** `{{hooks.…}}` in login steps: they run before the setup hooks. */
function hookTokens(v: unknown, path: IssuePath, ctx: CheckContext): void {
  if (typeof v === 'string') {
    const m = /\{\{\s*(hooks\.[^{}]*?)\s*\}\}/.exec(v);
    if (m) ctx.error(path, `{{${m[1]}}} is not available in login steps: they run before the setup hooks`);
  } else if (Array.isArray(v)) v.forEach((x, i) => hookTokens(x, [...path, i], ctx));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (k !== 'note') hookTokens(x, [...path, k], ctx);
}

/**
 * Semantic checks of `auth` (L1.6): global or per environment; the legacy single-account form (a warning: a path that
 * only exists on one computer) never mixed with personas; persona names, their pages (an environment page belongs to
 * at most one persona), their check and sign-in patterns, and their login steps (no literal password, no hook result).
 */
export function checkAuth(
  auth: unknown,
  envs: Record<string, unknown>,
  ctx: CheckContext,
  scope: { vars: ReadonlySet<string> },
  opts: AuthCheckOptions = {},
): void {
  if (!isObj(auth) || ctx.broken(['auth'])) return;
  const envNames = Object.keys(envs);
  const pagesOf = (env: string): string[] => (isObj(envs[env]) ? Object.keys(envs[env] as object) : []);
  /** Page key → base URL of a block's environments (the first environment that declares a key). */
  const urlsOf = (names: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const e of names) {
      const ps = envs[e];
      if (!isObj(ps)) continue;
      for (const [k, u] of Object.entries(ps)) if (typeof u === 'string' && !Object.hasOwn(out, k)) out[k] = u;
    }
    return out;
  };
  const global = isGlobalAuth(auth);
  if (!global) {
    for (const k of Object.keys(auth)) {
      if (opts.sandboxes?.includes(k)) {
        ctx.error(['auth'], `the personas of sandbox ${k} come from \`accounts:\` in its sandbox.yaml: remove auth.${k}`, { path: ['auth', k], key: true });
      } else if (!Object.hasOwn(envs, k)) {
        ctx.error(['auth'], `auth key "${k}" is not an environment${suggestion(k, envNames)} (available: ${envNames.join(', ') || 'none'})`, {
          path: ['auth', k],
          key: true,
        });
      }
    }
  }
  for (const e of envNames) {
    if (AUTH_KEYS.includes(e)) {
      ctx.error(['environments', e], `environment name "${e}" is also an \`auth\` key (${AUTH_KEYS.join(', ')}): rename the environment`, { path: ['environments', e], key: true });
    }
  }
  const blocks: Array<{ path: IssuePath; block: unknown; envs: string[] }> = global
    ? [{ path: ['auth'], block: auth, envs: envNames }]
    : Object.entries(auth)
        .filter(([env]) => Object.hasOwn(envs, env))
        .map(([env, block]) => ({ path: ['auth', env], block, envs: [env] }));
  for (const { path, block, envs: blockEnvs } of blocks) {
    if (!isObj(block)) continue;
    const keys = [...new Set(blockEnvs.flatMap(pagesOf))];
    const urls = { ...Object.fromEntries(keys.map((k) => [k, ''])), ...urlsOf(blockEnvs) };
    const legacy = LEGACY_KEYS.filter((k) => block[k] !== undefined);
    if (legacy.length && block.personas !== undefined) {
      ctx.error([...path, 'personas'], `\`${legacy.join('` / `')}\` (one account) and \`personas\` cannot be mixed: name the account as a persona and remove \`${legacy.join('` / `')}\``);
    } else if (legacy.length) {
      ctx.warning(
        [...path, legacy[0]],
        `\`${legacy[0]}\` is a path that only exists on this computer: name the account in \`personas\` instead (its session then lives in ~/.retake, outside the project) — it still works, as persona "default"`,
      );
    }
    if (block.login_url !== undefined) checkPatterns(block.login_url, [...path, 'login_url'], urls, ctx);
    if (!isObj(block.personas)) continue;
    const seen = new Map<string, string>();
    for (const [name, p] of Object.entries(block.personas)) {
      const pp: IssuePath = [...path, 'personas', name];
      const lower = name.toLowerCase();
      if (name === PERSONA_NONE) ctx.error(pp, `"${PERSONA_NONE}" is reserved (\`persona: none\` films a page without any persona): pick another name`, { path: pp, key: true });
      else if (seen.has(lower)) ctx.error(pp, `persona "${name}" differs from "${seen.get(lower)}" only by case (their session folders would be the same on macOS)`, { path: pp, key: true });
      seen.set(lower, name);
      if (!isObj(p)) continue;
      const pages = Array.isArray(p.pages) ? p.pages.filter((x): x is string => typeof x === 'string') : [];
      pages.forEach((page, i) => {
        if (!keys.includes(page)) {
          ctx.error([...pp, 'pages', i], `unknown page "${page}"${suggestion(page, keys)} (${global ? 'environment pages' : `environment ${blockEnvs[0]}`}: ${keys.join(', ') || 'none'})`);
          return;
        }
        // Several personas may list one page (one app, several roles — hotfix v0.2.2): the first one declared is the
        // page's default, a scene names another with `persona:`.
      });
      const check = isObj(p.check) ? p.check : undefined;
      if (check && typeof check.url === 'string') {
        const u = check.url;
        const prefix = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(u)?.[1];
        if (prefix && !/^(https?|file|about|data)$/i.test(prefix) && !splitPageOpen(u, keys)) {
          ctx.error([...pp, 'check', 'url'], `"${prefix}:" is not an environment page${suggestion(prefix, keys)} (pages: ${keys.join(', ') || 'none'})`);
        } else if (u.startsWith('/') && pages.length === 0 && keys.length === 0) {
          ctx.error([...pp, 'check', 'url'], `"${u}" is a path but persona "${name}" has no pages: write "<page>:${u}"`);
        }
      }
      if (check?.expect_not_url !== undefined) checkPatterns(check.expect_not_url, [...pp, 'check', 'expect_not_url'], urls, ctx);
      if (p.login_url !== undefined) checkPatterns(p.login_url, [...pp, 'login_url'], urls, ctx);
      if (!check && p.login_url === undefined && block.login_url === undefined) {
        ctx.warning(pp, `persona "${name}" has no \`check\` and no \`login_url\`: an expired session is only noticed when a step fails (add check: {url, expect_text})`);
      }
      if (Array.isArray(p.login) && !ctx.broken([...pp, 'login'])) {
        p.login.forEach((step, i) => {
          if (isObj(step) && literalPassword(step)) {
            ctx.warning(
              [...pp, 'login', i, 'type', 'text'],
              opts.accounts
                ? 'a password written in a login step: write {{account.password}} (the account\'s password is masked in logs)'
                : 'a password written in project.yaml: use {{env:VAR}} or {{keychain:service/account}}',
            );
          }
        });
        hookTokens(p.login, [...pp, 'login'], ctx);
        const tokenScope: TokenScope = { pages: keys, vars: scope.vars, varsComplete: true, saved: new Set(), ...(opts.accounts ? { account: 'login' as const } : {}) };
        checkTokens(stripHookTokens(p.login), [...pp, 'login'], tokenScope, ctx);
      }
    }
  }
}

/** Login steps without their {{hooks.…}} tokens (reported once by hookTokens). */
function stripHookTokens(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\{\{\s*hooks\.[^{}]*?\s*\}\}/g, '');
  if (Array.isArray(v)) return v.map(stripHookTokens);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripHookTokens(x)]));
  return v;
}
