import { isAbsolute } from 'node:path';
import { sandboxOffArgsProblems } from '../agent-policy.js';
import { AUTH_KEYS } from '../auth.js';
import { environmentAccess, environmentHttpCredentials, rawEnvironmentPages, rawEnvironments } from '../env.js';
import { allowedHosts, isHostAllowed } from '../hosts.js';
import type { IssuePath } from '../issues.js';
import { parseRequestPattern } from '../writes.js';
import { KEY_RE, SLUG_RE } from '../schemas/primitives.js';
import type { LocatedIssue } from '../validation/located.js';
import { suggestion } from '../validation/suggest.js';
import { CheckContext, isObj } from './context.js';
import { checkAuth, checkPersonaPaths } from './auth.js';
import { checkHooks, checkNamedHooks } from './hooks.js';
import { checkTokens, checkVarsValues } from './tokens.js';

/** Template roots that a page key would shadow. */
export const RESERVED_PAGE_KEYS: ReadonlySet<string> = new Set(['vars', 'hooks', 'run', 'env', 'keychain', 'secret', 'response']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** user:password@ in a connection URL, unless the password is a {{secret}} reference. */
export function clearTextPassword(url: string): { host: string; password: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/@:]*:([^@/]+)@([^/:?]+)/i.exec(url);
  if (!m || m[1].includes('{{')) return null;
  return { host: m[2].toLowerCase(), password: m[1] };
}

/** A path written in a file that only exists on one computer (absolute, or under the home directory). */
export function machinePath(p: string): boolean {
  return p.startsWith('~') || isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** Every string of a value that contains `{{` (mocks are served as written: nothing in them is templated). */
function templatedStrings(v: unknown, path: IssuePath, out: IssuePath[] = []): IssuePath[] {
  if (typeof v === 'string') {
    if (v.includes('{{')) out.push(path);
  } else if (Array.isArray(v)) v.forEach((x, i) => templatedStrings(x, [...path, i], out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) templatedStrings(x, [...path, k], out);
  return out;
}

/**
 * Mocks and allow entries (L1.7) of a scenario or an environment: the page key of each pattern must be one of the
 * environment's pages, a mock has at most one of `json` / `body`, and nothing in a mock is templated.
 */
export function checkWriteRules(
  list: unknown,
  base: IssuePath,
  pages: readonly string[] | undefined,
  ctx: CheckContext,
  what: 'mock' | 'allow',
  envName?: string,
): void {
  if (!Array.isArray(list)) return;
  list.forEach((entry, i) => {
    const p = [...base, i];
    if (ctx.broken(p)) return;
    const request = typeof entry === 'string' ? entry : isObj(entry) && typeof entry.request === 'string' ? entry.request : undefined;
    const rp = typeof entry === 'string' ? p : [...p, 'request'];
    if (request !== undefined && pages) {
      let page: string | undefined;
      try {
        page = parseRequestPattern(request).page;
      } catch {
        page = undefined;
      }
      if (page !== undefined && !pages.includes(page)) {
        ctx.error(rp, `unknown page "${page}"${suggestion(page, [...pages])} in the request pattern (${envName ? `environment ${envName} has` : 'pages'}: ${pages.join(', ') || 'none'})`);
      }
    }
    if (what !== 'mock' || !isObj(entry)) return;
    if (entry.json !== undefined && entry.body !== undefined) ctx.error(p, 'a mock answers with `json` or `body`, not both');
    for (const tp of templatedStrings(entry, p)) ctx.error(tp, 'mocks are served as written: {{…}} is not templated in a mock (write the value)');
  });
}

/** The long form's `read_only` (L1.7): its patterns, and whether the environment can be read-only at all. */
function checkReadOnly(env: Record<string, unknown>, envName: string, pages: readonly string[], ctx: CheckContext): void {
  const ro = env.read_only;
  if (!isObj(ro) || ctx.broken(['environments', envName, 'read_only'])) return;
  const base: IssuePath = ['environments', envName, 'read_only'];
  checkWriteRules(ro.allow, [...base, 'allow'], pages, ctx, 'allow', envName);
  checkWriteRules(ro.mocks, [...base, 'mocks'], pages, ctx, 'mock', envName);
  const production = env.production === true;
  const access = env.access === 'read-only' || env.access === 'read-write' ? env.access : undefined;
  if (!production && environmentAccess({ access }) === 'read-write') {
    ctx.warning(
      base,
      `read_only applies only to read-only runs, and environment ${envName} is read-write: set \`access: read-only\` (or \`production: true\`) to use it`,
      { path: base, key: true },
    );
  }
}

/**
 * project.yaml `sandboxes:` (L1.8): environment name → its sandbox.yaml. A name is slug-like, not an environment of
 * project.yaml nor an `auth` key; the path is relative to the project and the file exists (when the project dir is
 * known). Returns the sandbox names (the valid and the refused ones: other checks then know them).
 */
function checkSandboxEntries(sandboxes: unknown, envs: Record<string, unknown>, ctx: CheckContext): string[] {
  if (!isObj(sandboxes) || ctx.broken(['sandboxes'])) return [];
  for (const [name, rel] of Object.entries(sandboxes)) {
    const at: IssuePath = ['sandboxes', name];
    const loc = { path: at, key: true };
    if (!SLUG_RE.test(name)) ctx.error(['sandboxes'], `sandbox name "${name}" must be slug-like (letters, digits, "-" or "_"): it is an environment name`, loc);
    else if (Object.hasOwn(envs, name)) {
      ctx.error(['sandboxes'], `"${name}" is already an environment of project.yaml: a sandbox is an environment of its own — give it another name`, loc);
    } else if (AUTH_KEYS.includes(name)) {
      ctx.error(['sandboxes'], `sandbox name "${name}" is also an \`auth\` key (${AUTH_KEYS.join(', ')}): rename the sandbox`, loc);
    }
    if (typeof rel !== 'string') continue;
    if (machinePath(rel)) ctx.error(at, `"${rel}" only exists on this computer: write the path of sandbox.yaml relative to the project`);
    else ctx.file(rel, at, 'sandbox manifest', 'error');
  }
  return Object.keys(sandboxes);
}

/** `browser.args` of project.yaml or retake.yaml: no switch that turns Chromium's sandbox or site isolation off. */
export function checkBrowserArgs(browser: unknown, ctx: CheckContext): void {
  if (!isObj(browser) || !Array.isArray(browser.args)) return;
  for (const { index, message } of sandboxOffArgsProblems(browser.args)) ctx.error(['browser', 'args', index], message);
}

/** Semantic checks of a retake.yaml value. */
export function checkWorkspace(value: unknown, structural: readonly LocatedIssue[]): LocatedIssue[] {
  if (!isObj(value)) return [];
  const ctx = new CheckContext(structural);
  checkBrowserArgs(value.browser, ctx);
  return ctx.out;
}

/** Semantic checks of a project.yaml value; `projectDir` resolves hook files. */
export function checkProject(
  value: unknown,
  structural: readonly LocatedIssue[],
  opts: { projectDir?: string } = {},
): LocatedIssue[] {
  if (!isObj(value)) return [];
  const ctx = new CheckContext(structural, opts.projectDir);
  const written = isObj(value.environments) && !ctx.broken(['environments']) ? value.environments : {};
  // Both forms (L1.7): the page map of each environment, `{url, display}` reduced to its url.
  const raw = rawEnvironments(written);
  const envs = rawEnvironmentPages(written);
  const envNames = Object.keys(envs);
  const pageKeys = new Set<string>();

  // Sandbox environments (L1.8): their pages, personas, mailbox and databases come from their sandbox.yaml.
  const sandboxNames = checkSandboxEntries(value.sandboxes, envs, ctx);
  if (!ctx.broken(['environments']) && (value.environments === undefined || envNames.length === 0) && sandboxNames.length === 0) {
    ctx.warning(['environments'], 'no environments yet: add environments.<env>.<page>: <url> before running scenarios');
  }
  for (const [envName, { pages, pagesPath }] of Object.entries(raw)) {
    if (!SLUG_RE.test(envName)) {
      ctx.error(['environments'], `environment name "${envName}" must be slug-like (letters, digits, "-" or "_")`, {
        path: ['environments', envName],
        key: true,
      });
    }
    const at = ['environments', envName, ...pagesPath];
    for (const key of Object.keys(pages)) {
      pageKeys.add(key);
      const loc = { path: [...at, key], key: true };
      if (!KEY_RE.test(key)) {
        ctx.error(at, `page key "${key}" must be an identifier (used as {{${key}}})`, loc);
      } else if (RESERVED_PAGE_KEYS.has(key)) {
        ctx.error(at, `page key "${key}" is reserved for templating ({{${key}.…}})`, loc);
      }
    }
    if (isObj(written[envName]) && raw[envName].long) checkReadOnly(written[envName], envName, Object.keys(pages), ctx);
    const urls = Object.fromEntries(Object.entries(pages).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const credentials = environmentHttpCredentials({ config: { environments: { [envName]: urls } } as never }, envName);
    if (credentials.problem) ctx.error(at, credentials.problem);
  }

  if (typeof value.default_env === 'string' && !Object.hasOwn(envs, value.default_env) && !sandboxNames.includes(value.default_env)) {
    const all = [...envNames, ...sandboxNames];
    ctx.error(
      ['default_env'],
      `unknown environment "${value.default_env}"${suggestion(value.default_env, all)} (available: ${all.join(', ') || 'none'})`,
    );
  }

  checkBrowserArgs(value.browser, ctx);

  // Sessions & personas (L1.6): a persona's session path is refused even where the schema already failed.
  checkPersonaPaths(value.auth, ctx);
  checkAuth(value.auth, envs, ctx, { vars: new Set(isObj(value.vars) ? Object.keys(value.vars) : []) }, { sandboxes: sandboxNames });

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

  // The allow-list (environment hosts, allow_hosts, localhost) of the mailbox and of `reset:` shell hooks.
  const config = {
    environments: envs as Record<string, Record<string, string>>,
    allow_hosts: Array.isArray(value.allow_hosts) ? value.allow_hosts.filter((h): h is string => typeof h === 'string') : undefined,
  };
  if (isObj(value.mailbox) && typeof value.mailbox.url === 'string' && !ctx.broken(['mailbox'])) {
    // The mailbox is contacted by the runner like an http hook: its host must be in the allow-list.
    let host = '';
    try {
      host = new URL(value.mailbox.url).hostname;
    } catch {
      /* the schema reports a malformed URL */
    }
    if (host && !isHostAllowed(host, { config: config as never })) {
      ctx.error(
        ['mailbox', 'url'],
        `mailbox host ${host} is not allowed: use localhost, an environment host, or add it to allow_hosts (allowed: ${allowedHosts({ config: config as never }).join(', ')})`,
      );
    }
  }

  const saved = new Set<string>();
  checkHooks(value.reset, ['reset'], ctx, { pages: [...pageKeys], saved, project: { config: config as never } });
  checkNamedHooks(value.hooks, ['hooks'], ctx, { pages: [...pageKeys], saved: new Set<string>(), project: { config: config as never } });
  const vars = new Set(isObj(value.vars) ? Object.keys(value.vars) : []);
  if (value.vars !== undefined && !ctx.broken(['vars'])) checkVarsValues(value.vars, ['vars'], ctx);
  const scope = { pages: [...pageKeys], vars, varsComplete: true, saved };
  for (const key of ['reset', 'databases', 'mailbox'] as const) {
    if (value[key] !== undefined && !ctx.broken([key])) checkTokens(value[key], [key], scope, ctx);
  }
  return ctx.out;
}
