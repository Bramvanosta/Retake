/**
 * Semantic checks of a sandbox.yaml, positioned in that file: the provider's own keys, paths relative to the
 * manifest, loopback-only URLs, pages, seed steps (the hook checks, without the destructive confirmation), the reset
 * strategy, databases and mailbox, and the accounts (the persona checks of project.yaml `auth`, plus
 * {{account.username}} / {{account.password}}). Given the project, a sandbox page sharing its host and port with a page
 * of a production or read-only environment is an error.
 */
import { resolve } from 'node:path';
import { needFiles } from '../file-facts.js';
import type { FileFacts, FilesWith } from '../file-facts.js';
import { environmentAccess } from '../env.js';
import { isLoopbackHost } from '../hosts.js';
import type { IssuePath } from '../issues.js';
import { KEY_RE } from '../schemas/primitives.js';
import type { LoadedProject } from '../types/project.js';
import type { LocatedIssue } from '../validation/located.js';
import { suggestion } from '../validation/suggest.js';
import { CheckContext, isObj } from './context.js';
import { RESERVED_PAGE_KEYS, clearTextPassword } from './project.js';
import { checkAccounts, unmaskedPasswordReason, weakPasswordReason } from './sandbox-accounts.js';
import { DEFAULT_COMPOSE_FILES, DIR_LABEL, checkEnvFile, checkRelative, composeServices } from './sandbox-files.js';
import { checkSteps } from './sandbox-steps.js';
import type { Provider, SandboxPage, StepsContext } from './sandbox-steps.js';
import { checkTokens } from './tokens.js';
import type { TokenScope } from './tokens.js';
import { decodeOrKeep } from '../util.js';

export { unmaskedPasswordReason, weakPasswordReason } from './sandbox-accounts.js';
export { DEFAULT_COMPOSE_FILES, composeEnvFilePath, composeEnvRef, envFileKeys, envFileValues } from './sandbox-files.js';

/** Postgres truncates identifiers at 63 bytes: the snapshot database is `<db>__retake_snap`. */
export const SNAPSHOT_DATABASE_MAX = 50;
/** Databases a snapshot reset never drops. */
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);
/** Keys of a service that only a process sandbox uses. */
const PROCESS_KEYS = ['command', 'cwd', 'env', 'stop_timeout_s'] as const;

/** The options of sandbox.yaml's checks; `files` is required with `dir` (FilesWith). */
export type SandboxCheckOptions = SandboxCheckFields & FilesWith<'dir'>;

export interface SandboxCheckFields {
  /** Folder of sandbox.yaml: its relative paths resolve against it (undefined: files are not checked). */
  dir?: string;
  /** How its files are looked at (core FileFacts): required with `dir`. */
  files?: FileFacts;
  /** The environment name it becomes (messages). */
  env?: string;
  /**
   * The project it belongs to (its normalised project.yaml, sandboxes not merged): vars, the allow-list, and the pages
   * of its production / read-only environments (a sandbox page must not share their host and port).
   */
  project?: Pick<LoadedProject, 'config'>;
}

const LOOPBACK_HINT = 'sandbox URLs name localhost, *.localhost, 127.0.0.1 or [::1] only: a sandbox is reset — its databases dropped and recreated — before every take';

/** The host of a URL as written ('' when it has none); null when it cannot be read or its host is templated. */
function urlHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host.includes('{') || host.includes('%7B')) return null;
  return host;
}

/**
 * `host:port` of an http(s) URL (the default port written out), or null. Every loopback host counts as one
 * (`localhost`): 127.0.0.1:4401, [::1]:4401 and localhost:4401 reach the same server.
 */
function hostPort(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${isLoopbackHost(u.hostname) ? 'localhost' : u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

/** A URL of the sandbox must be on this machine (loopback). */
function checkLoopback(url: unknown, path: IssuePath, what: string, ctx: CheckContext): void {
  if (typeof url !== 'string' || ctx.broken(path)) return;
  const host = urlHost(url);
  if (host === null) {
    ctx.error(path, `${what}: write its host as it is (localhost) — only the password may be a {{env:VAR}} / {{keychain:…}} reference`);
  } else if (host === '') {
    ctx.error(path, `${what} has no host: write localhost (${LOOPBACK_HINT})`);
  } else if (!isLoopbackHost(host)) {
    ctx.error(path, `${what} ${host} is not on this machine: ${LOOPBACK_HINT}`);
  }
}

/**
 * Query parameters of a database URL that send the connection elsewhere than the host, port and database it names
 * (pg reads `host` — a unix socket too — and `port`; libpq `hostaddr`, `service`, `dbname`): refused in a sandbox, whose
 * database a reset rewrites.
 */
const DATABASE_TARGET_PARAMS = ['host', 'hostaddr', 'port', 'service', 'dbname'];

/** A database URL of the sandbox: loopback, and connecting where it says (no target parameter, nothing templated but the password). */
function checkDatabaseUrl(url: string, path: IssuePath, key: string, ctx: CheckContext): void {
  checkLoopback(url, path, `database ${key}`, ctx);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const params = [...new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()))].filter((k) => DATABASE_TARGET_PARAMS.includes(k));
  if (params.length) {
    ctx.error(
      path,
      `database ${key}: the query parameter${params.length === 1 ? '' : 's'} ${params.map((k) => `"${k}"`).join(', ')} would connect elsewhere than the host and port the URL names (another server, a unix socket) — write them in the URL itself: postgres://user:password@localhost:<port>/<db>`,
    );
  } else if (/\{\{|%7B/i.test(u.search)) {
    ctx.error(path, `database ${key}: its query string is templated — only the password may be a {{env:VAR}} / {{keychain:…}} reference`);
  }
}

/** A directory relative to the sandbox folder must exist. */
function checkDir(rel: string, path: IssuePath, what: string, ctx: CheckContext): void {
  if (!ctx.projectDir) return;
  const abs = resolve(ctx.projectDir, rel);
  const files = needFiles(ctx.files, 'a folder check');
  let ok = false;
  try {
    ok = files.kind(abs) === 'directory';
  } catch {
    ok = false;
  }
  if (!ok) ctx.error(path, `${what} "${rel}" not found in ${DIR_LABEL}`);
}

/** Semantic checks of a sandbox.yaml value (schema issues in `structural`). */
export function checkSandbox(value: unknown, structural: readonly LocatedIssue[], opts: SandboxCheckOptions = {}): LocatedIssue[] {
  if (!isObj(value)) return [];
  const ctx = new CheckContext(structural, opts.dir, DIR_LABEL, opts.files);
  const provider = value.provider === 'docker-compose' || value.provider === 'process' ? value.provider : undefined;
  const services = isObj(value.services) ? value.services : {};
  const config = opts.project?.config;
  const vars = new Set(Object.keys(config?.vars ?? {}));

  const { composeNames, profiled } = checkComposeFiles(value, provider, ctx);
  const pages = checkServices(services, { provider, composeNames, profiled }, ctx);
  const pageKeys = [...pages.keys()];
  if (config) checkGuardedPages(config, pages, ctx);

  // ── Template tokens: the sandbox's pages, the project's vars and secret references ──
  const saved = new Set<string>();
  const scope: TokenScope = { pages: pageKeys, vars, varsComplete: config !== undefined, saved, account: 'elsewhere' };

  const databases = isObj(value.databases) ? value.databases : {};
  checkDatabases(databases, ctx);

  // ── Seed (and, hotfix v0.2.5, reset.hooks: the same steps, run at every reset) ──
  const steps: StepsContext = { value, provider, services, composeNames, profiled, pages, scope, saved, env: opts.env ?? 'sandbox', config };
  if (Array.isArray(value.seed)) checkSteps(value.seed, ['seed'], steps, ctx);
  if (isObj(value.reset) && Array.isArray(value.reset.hooks) && !ctx.broken(['reset'])) checkSteps(value.reset.hooks, ['reset', 'hooks'], steps, ctx);

  if (isObj(value.reset) && !ctx.broken(['reset'])) checkReset(value.reset, { databases, provider, services }, ctx);

  // ── Mailbox ──
  if (isObj(value.mailbox) && !ctx.broken(['mailbox'])) {
    checkLoopback(value.mailbox.url, ['mailbox', 'url'], 'mailbox', ctx);
    if (value.mailbox.provider === 'http' && value.mailbox.clear === true) {
      ctx.warning(['mailbox', 'clear'], 'an http mailbox has no generic way to be emptied: `clear` applies to Mailpit only (empty it in a seed step)');
    }
  }
  for (const key of ['databases', 'mailbox'] as const) {
    if (value[key] !== undefined && !ctx.broken([key])) checkTokens(value[key], [key], scope, ctx);
  }
  for (const [name, svc] of Object.entries(services)) {
    if (isObj(svc) && svc.env !== undefined && !ctx.broken(['services', name, 'env'])) checkTokens(svc.env, ['services', name, 'env'], scope, ctx);
  }

  // ── Accounts: the personas of the sandbox's environment ──
  checkAccounts(value, ctx, { pageKeys, pageUrls: Object.fromEntries([...pages].map(([k, p]) => [k, p.url])), vars, env: opts.env ?? 'sandbox' });
  return ctx.out;
}

/** The compose files (docker-compose): the services they declare (undefined when they cannot be read) and those under `profiles:`. */
function checkComposeFiles(value: Record<string, unknown>, provider: Provider, ctx: CheckContext): { composeNames: Set<string> | undefined; profiled: Set<string> } {
  let composeNames: Set<string> | undefined;
  const profiled = new Set<string>();
  if (value.compose !== undefined && provider === 'process') {
    ctx.error(['compose'], '`compose` is for provider docker-compose (this sandbox starts local processes)', { path: ['compose'], key: true });
  } else if (provider === 'docker-compose' && !ctx.broken(['compose'])) {
    const c = isObj(value.compose) ? value.compose : {};
    const written = Array.isArray(c.files);
    const files = written ? (c.files as unknown[]).filter((f): f is string => typeof f === 'string') : [...DEFAULT_COMPOSE_FILES];
    composeNames = composeServices(files, written ? ['compose', 'files'] : ['provider'], written, ctx, profiled);
    checkEnvFile(c, files, ctx);
  }
  return { composeNames, profiled };
}

/** Services and their pages: the pages of the sandbox, by key. */
function checkServices(
  services: Record<string, unknown>,
  { provider, composeNames, profiled }: { provider: Provider; composeNames: Set<string> | undefined; profiled: ReadonlySet<string> },
  ctx: CheckContext,
): Map<string, SandboxPage> {
  const compose = provider === 'docker-compose';
  const pages = new Map<string, SandboxPage>();
  for (const [name, svc] of Object.entries(services)) {
    const sp: IssuePath = ['services', name];
    if (!isObj(svc)) continue;
    if (composeNames && !composeNames.has(name)) {
      ctx.error(['services'], `service "${name}" is not a service of the compose files${suggestion(name, [...composeNames])} (they declare: ${[...composeNames].join(', ') || 'none'})`, {
        path: sp,
        key: true,
      });
    } else if (profiled.has(name)) {
      ctx.error(['services'], `service "${name}" has \`profiles:\` in the compose files: a sandbox never starts it (Retake runs docker compose without COMPOSE_PROFILES) — remove its \`profiles\``, {
        path: sp,
        key: true,
      });
    }
    if (compose) {
      for (const k of PROCESS_KEYS) {
        if (svc[k] !== undefined) ctx.error([...sp, k], `\`${k}\` is for provider process: a docker-compose service is started from its compose file`, { path: [...sp, k], key: true });
      }
    } else if (provider === 'process' && svc.command === undefined) {
      ctx.error(sp, `service ${name} needs \`command\`: the program the sandbox starts (provider process)`, { path: sp, key: true });
    }
    if (provider === 'process' && !ctx.broken([...sp, 'cwd']) && checkRelative(svc.cwd, [...sp, 'cwd'], 'cwd', ctx)) checkDir(svc.cwd as string, [...sp, 'cwd'], 'cwd', ctx);
    checkLoopback(svc.url, [...sp, 'url'], `service ${name} url`, ctx);
    if (isObj(svc.pages)) checkServicePages(name, svc.pages, pages, ctx);
    checkHealth(svc, sp, compose, ctx);
  }
  if (!ctx.broken(['services']) && Object.keys(services).length > 0 && pages.size === 0) {
    ctx.error(['services'], 'a sandbox needs at least one page: add `pages: {app: http://localhost:<port>}` to the service that serves the product', { path: ['services'], key: true });
  }
  return pages;
}

/** The pages of one service: identifier keys, not reserved, one service per key, local URLs (added to `pages`). */
function checkServicePages(name: string, servicePages: Record<string, unknown>, pages: Map<string, SandboxPage>, ctx: CheckContext): void {
  const sp: IssuePath = ['services', name];
  for (const [key, pv] of Object.entries(servicePages)) {
    const pp: IssuePath = [...sp, 'pages', key];
    const loc = { path: pp, key: true };
    if (!KEY_RE.test(key)) ctx.error([...sp, 'pages'], `page key "${key}" must be an identifier (used as {{${key}}})`, loc);
    else if (RESERVED_PAGE_KEYS.has(key)) ctx.error([...sp, 'pages'], `page key "${key}" is reserved for templating ({{${key}.…}})`, loc);
    const other = pages.get(key);
    if (other) ctx.error([...sp, 'pages'], `page "${key}" is already served by service ${other.service}: a page key names one page of the environment`, loc);
    const url = typeof pv === 'string' ? pv : isObj(pv) && typeof pv.url === 'string' ? pv.url : undefined;
    const up = typeof pv === 'string' ? pp : [...pp, 'url'];
    if (url === undefined || ctx.broken(up)) continue;
    checkLoopback(url, up, `page ${key}`, ctx);
    if (!other) pages.set(key, { service: name, url, path: up });
  }
}

/** The project: no sandbox page on the host and port of a production / read-only page. */
function checkGuardedPages(config: LoadedProject['config'], pages: ReadonlyMap<string, SandboxPage>, ctx: CheckContext): void {
  const guarded = new Map<string, string>();
  const guardedUrl = new Map<string, string>();
  for (const [env, envPages] of Object.entries(config.environments ?? {})) {
    const s = config.environment_settings?.[env];
    if (s?.sandbox || environmentAccess({ production: s?.production, access: s?.access }) !== 'read-only') continue;
    for (const url of Object.values(envPages)) {
      const hp = hostPort(url);
      if (hp && !guarded.has(hp)) {
        guarded.set(hp, env);
        guardedUrl.set(hp, new URL(url).host);
      }
    }
  }
  for (const [key, p] of pages) {
    const host = urlHost(p.url);
    if (!host || !isLoopbackHost(host)) continue; // refused as not local already
    const hp = hostPort(p.url);
    const env = hp ? guarded.get(hp) : undefined;
    if (env === undefined) continue;
    const production = config.environment_settings?.[env]?.production === true;
    const mine = new URL(p.url).host;
    const theirs = guardedUrl.get(hp!);
    ctx.error(
      p.path,
      `page ${key} (${mine}) is also a page of environment ${env}${theirs && theirs !== mine ? ` (${theirs}: the same server)` : ''}, which is ${production ? 'production' : 'read-only'}: a sandbox is reset — its data dropped — before every take; give it a port of its own`,
    );
  }
}

/** Databases: local URLs that connect where they say, and a plain password that is masked in the logs. */
function checkDatabases(databases: Record<string, unknown>, ctx: CheckContext): void {
  for (const [key, db] of Object.entries(databases)) {
    const dp: IssuePath = ['databases', key, 'url'];
    if (!isObj(db) || typeof db.url !== 'string' || ctx.broken(dp)) continue;
    checkDatabaseUrl(db.url, dp, key, ctx);
    const plain = clearTextPassword(db.url);
    const password = plain ? decodeOrKeep(plain.password) : null;
    const unmasked = password === null ? null : unmaskedPasswordReason(password);
    const weak = password === null || unmasked ? null : weakPasswordReason(password);
    if (unmasked) ctx.error(dp, unmasked);
    else if (weak) ctx.warning(dp, weak);
  }
}

/** Reset: the snapshot strategy, the Firebase Auth emulator, the services restarted. */
function checkReset(
  r: Record<string, unknown>,
  { databases, provider, services }: { databases: Record<string, unknown>; provider: Provider; services: Record<string, unknown> },
  ctx: CheckContext,
): void {
  const serviceNames = Object.keys(services);
  const snapshot = r.strategy === 'snapshot';
  if (snapshot) checkSnapshot(r, databases, provider, ctx);
  else if (r.snapshot !== undefined) {
    ctx.warning(['reset', 'snapshot'], '`snapshot` is only used with `strategy: snapshot` (this sandbox reseeds)', { path: ['reset', 'snapshot'], key: true });
  }
  if (isObj(r.firebase_auth)) checkLoopback(r.firebase_auth.url, ['reset', 'firebase_auth', 'url'], 'the Firebase Auth emulator', ctx);
  if (Array.isArray(r.restart)) {
    r.restart.forEach((s, i) => {
      if (typeof s === 'string' && !Object.hasOwn(services, s)) {
        ctx.error(['reset', 'restart', i], `unknown service "${s}"${suggestion(s, serviceNames)} (services: ${serviceNames.join(', ') || 'none'})`);
      }
    });
  }
}

/** A health path a URL parser would read as another host ("//host/up", "/\\host/up"): it must stay on the service's url. */
function leavesOrigin(path: string): boolean {
  return /^[/\\]{2}/.test(path) || path.includes('\\');
}

/** A service's health: one way to check it, local, and no TCP check on a port Docker publishes. */
function checkHealth(svc: Record<string, unknown>, sp: IssuePath, compose: boolean, ctx: CheckContext): void {
  const h = svc.health;
  const hp: IssuePath = [...sp, 'health'];
  if (h === undefined || h === false || ctx.broken(hp)) return;
  if (typeof h === 'string') {
    if (/^https?:\/\//i.test(h)) checkLoopback(h, hp, 'health url', ctx);
    else if (!h.startsWith('/')) ctx.error(hp, `"${h}" is neither a path ("/health") nor a local http(s) URL`);
    else if (leavesOrigin(h)) ctx.error(hp, `"${h}" could leave the service's url ("//…" names another host, and a "\\" counts as "/"): write a path ("/health") or an absolute local URL`);
    else if (svc.url === undefined) ctx.error(hp, `a health path needs the service's \`url\` (or write an absolute local URL)`);
    return;
  }
  if (!isObj(h)) return;
  const ways = (['path', 'url', 'tcp'] as const).filter((k) => h[k] !== undefined);
  if (ways.length > 1) ctx.error(hp, `health checks one way: \`${ways.join('` or `')}\`, not both`);
  if (h.tcp !== undefined) {
    if (compose) {
      ctx.error([...hp, 'tcp'], 'a TCP check of a port Docker publishes always succeeds (its proxy accepts the connection): give the compose service a healthcheck, or check an http path', {
        path: [...hp, 'tcp'],
        key: true,
      });
    }
    for (const k of ['status', 'text'] as const) {
      if (h[k] !== undefined) ctx.error([...hp, k], `\`${k}\` is for an http health check, not \`tcp\``, { path: [...hp, k], key: true });
    }
  }
  if (h.url !== undefined) checkLoopback(h.url, [...hp, 'url'], 'health url', ctx);
  if (ways.length === 0 || h.path !== undefined) {
    if (typeof h.path === 'string' && !h.path.startsWith('/')) ctx.error([...hp, 'path'], `"${h.path}" is not a path: write "/${h.path}"`);
    else if (typeof h.path === 'string' && leavesOrigin(h.path))
      ctx.error([...hp, 'path'], `"${h.path}" could leave the service's url ("//…" names another host, and a "\\" counts as "/"): write a path ("/health")`);
    else if (svc.url === undefined) ctx.error(hp, `an http health check needs the service's \`url\` (or \`url\` here)`);
  }
}

/** reset.strategy snapshot: a Postgres database of the sandbox's own compose project, never a system one. */
function checkSnapshot(r: Record<string, unknown>, databases: Record<string, unknown>, provider: string | undefined, ctx: CheckContext): void {
  if (provider === 'process') {
    ctx.error(['reset', 'strategy'], "snapshot resets need provider docker-compose: the database must belong to the sandbox's own compose project (a process sandbox reseeds — strategy: reseed)");
    return;
  }
  const keys = Object.keys(databases);
  const snap = isObj(r.snapshot) ? r.snapshot : {};
  const key = typeof snap.database === 'string' ? snap.database : keys[0];
  const at: IssuePath = typeof snap.database === 'string' ? ['reset', 'snapshot', 'database'] : ['reset', 'strategy'];
  if (key === undefined) {
    ctx.error(at, 'a snapshot reset needs the Postgres database it snapshots: add `databases: {main: {url: "postgres://…@localhost:<port>/<db>"}}`');
    return;
  }
  if (!Object.hasOwn(databases, key)) {
    ctx.error(at, `unknown database "${key}"${suggestion(key, keys)} (databases: ${keys.join(', ') || 'none'})`);
    return;
  }
  const db = databases[key];
  if (!isObj(db) || typeof db.url !== 'string') return;
  let u: URL;
  try {
    u = new URL(db.url);
  } catch {
    return;
  }
  if (!/^postgres(ql)?:$/i.test(u.protocol)) {
    ctx.error(at, `database ${key} is not a Postgres URL (postgres://…): snapshots are Postgres template copies (other databases: strategy reseed)`);
    return;
  }
  const name = decodeOrKeep(u.pathname.replace(/^\//, ''));
  if (!name) ctx.error(['databases', key, 'url'], `database ${key}: the URL names no database (postgres://…/<db>): a snapshot drops and recreates that database`);
  else if (SYSTEM_DATABASES.has(name.toLowerCase())) {
    ctx.error(['databases', key, 'url'], `database ${key} is "${name}": a snapshot reset drops and recreates its database at every take — give the sandbox a database of its own`);
  } else if (name.length > SNAPSHOT_DATABASE_MAX) {
    ctx.error(['databases', key, 'url'], `database name "${name}" is longer than ${SNAPSHOT_DATABASE_MAX} characters: its snapshot "${name}__retake_snap" would be cut by Postgres (63 bytes at most)`);
  }
}
