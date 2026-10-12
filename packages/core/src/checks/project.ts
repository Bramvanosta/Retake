import { allowedHosts, isHostAllowed } from '../hosts.js';
import { KEY_RE, SLUG_RE } from '../schemas/primitives.js';
import type { LocatedIssue } from '../validation/located.js';
import { suggestion } from '../validation/suggest.js';
import { CheckContext, isObj } from './context.js';
import { checkHooks } from './hooks.js';
import { checkTokens } from './tokens.js';

/** Template roots that a page key would shadow. */
const RESERVED_PAGE_KEYS = new Set(['vars', 'hooks', 'run', 'env', 'keychain', 'secret', 'response']);
const AUTH_KEYS = new Set(['profile', 'storage_state']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** user:password@ in a connection URL, unless the password is a {{secret}} reference. */
function clearTextPassword(url: string): { host: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/@:]*:([^@/]+)@([^/:?]+)/i.exec(url);
  if (!m || m[1].includes('{{')) return null;
  return { host: m[2].toLowerCase() };
}

/** Semantic checks of a project.yaml value; `projectDir` resolves hook files. */
export function checkProject(
  value: unknown,
  structural: readonly LocatedIssue[],
  opts: { projectDir?: string } = {},
): LocatedIssue[] {
  if (!isObj(value)) return [];
  const ctx = new CheckContext(structural, opts.projectDir);
  const envs = isObj(value.environments) && !ctx.broken(['environments']) ? value.environments : {};
  const envNames = Object.keys(envs);
  const pageKeys = new Set<string>();

  if (value.environments === undefined || envNames.length === 0) {
    ctx.warning(['environments'], 'no environments yet: add environments.<env>.<page>: <url> before running scenarios');
  }
  for (const [envName, pages] of Object.entries(envs)) {
    if (!SLUG_RE.test(envName)) {
      ctx.error(['environments'], `environment name "${envName}" must be slug-like (letters, digits, "-" or "_")`, {
        path: ['environments', envName],
        key: true,
      });
    }
    if (!isObj(pages)) continue;
    for (const key of Object.keys(pages)) {
      pageKeys.add(key);
      const loc = { path: ['environments', envName, key], key: true };
      if (!KEY_RE.test(key)) {
        ctx.error(['environments', envName], `page key "${key}" must be an identifier (used as {{${key}}})`, loc);
      } else if (RESERVED_PAGE_KEYS.has(key)) {
        ctx.error(['environments', envName], `page key "${key}" is reserved for templating ({{${key}.…}})`, loc);
      }
    }
  }

  if (typeof value.default_env === 'string' && !Object.hasOwn(envs, value.default_env)) {
    ctx.error(
      ['default_env'],
      `unknown environment "${value.default_env}"${suggestion(value.default_env, envNames)} (available: ${envNames.join(', ') || 'none'})`,
    );
  }

  if (isObj(value.auth) && !ctx.broken(['auth'])) {
    const keys = Object.keys(value.auth);
    const perEnv = keys.some((k) => !AUTH_KEYS.has(k));
    if (perEnv) {
      for (const k of keys) {
        if (!Object.hasOwn(envs, k)) {
          ctx.error(['auth'], `auth key "${k}" is not an environment${suggestion(k, envNames)} (available: ${envNames.join(', ') || 'none'})`, {
            path: ['auth', k],
            key: true,
          });
        }
      }
    }
  }

  if (isObj(value.databases)) {
    for (const [name, db] of Object.entries(value.databases)) {
      if (!isObj(db) || typeof db.url !== 'string') continue;
      const leak = clearTextPassword(db.url);
      if (!leak) continue;
      const msg = 'connection URL contains a clear-text password: use {{env:VAR}} or {{keychain:service/account}}';
      if (LOCAL_HOSTS.has(leak.host)) ctx.warning(['databases', name, 'url'], msg);
      else ctx.error(['databases', name, 'url'], msg);
    }
  }

  if (isObj(value.mailbox) && typeof value.mailbox.url === 'string' && !ctx.broken(['mailbox'])) {
    // The mailbox is contacted by the runner like an http hook: its host must be in the allow-list.
    let host = '';
    try {
      host = new URL(value.mailbox.url).hostname;
    } catch {
      /* the schema reports a malformed URL */
    }
    const config = {
      environments: envs as Record<string, Record<string, string>>,
      allow_hosts: Array.isArray(value.allow_hosts) ? value.allow_hosts.filter((h): h is string => typeof h === 'string') : undefined,
    };
    if (host && !isHostAllowed(host, { config: config as never })) {
      ctx.error(
        ['mailbox', 'url'],
        `mailbox host ${host} is not allowed: use localhost, an environment host, or add it to allow_hosts (allowed: ${allowedHosts({ config: config as never }).join(', ')})`,
      );
    }
  }

  const saved = new Set<string>();
  checkHooks(value.reset, ['reset'], ctx, { pages: [...pageKeys], saved });
  const vars = new Set(isObj(value.vars) ? Object.keys(value.vars) : []);
  const scope = { pages: [...pageKeys], vars, varsComplete: true, saved };
  for (const key of ['reset', 'databases', 'mailbox'] as const) {
    if (value[key] !== undefined && !ctx.broken([key])) checkTokens(value[key], [key], scope, ctx);
  }
  return ctx.out;
}
