/**
 * Semantic checks of a sandbox.yaml (L1.8), positioned in that file: the provider's own keys, paths relative to the
 * manifest, loopback-only URLs, pages, seed steps (the hook checks, without the destructive confirmation), the reset
 * strategy, databases and mailbox, and the accounts (the persona checks of project.yaml `auth`, plus
 * {{account.username}} / {{account.password}}). Given the project, a sandbox page sharing its host and port with a page
 * of a production or read-only environment is an error.
 */
import { dirname, join, resolve } from 'node:path';
import { parse as parseYamlText } from 'yaml';
import { sqlSource } from '../destructive.js';
import { needFiles } from '../file-facts.js';
import type { FileFacts } from '../file-facts.js';
import { environmentAccess } from '../env.js';
import { isHostAllowed, isLoopbackHost } from '../hosts.js';
import type { IssuePath } from '../issues.js';
import { KEY_RE } from '../schemas/primitives.js';
import { shellHostRefs } from '../shell-hosts.js';
import { collectSecretRefs, listTemplateTokens } from '../templating.js';
import type { LoadedProject } from '../types.js';
import type { LocatedIssue } from '../validation/located.js';
import { suggestion } from '../validation/suggest.js';
import { checkAuth } from './auth.js';
import { CheckContext, isObj } from './context.js';
import { checkHooks } from './hooks.js';
import { RESERVED_PAGE_KEYS, clearTextPassword, machinePath } from './project.js';
import { checkTokens } from './tokens.js';
import type { TokenScope } from './tokens.js';

/** Compose files read when `compose.files` is absent. */
export const DEFAULT_COMPOSE_FILES: readonly string[] = ['compose.yaml'];
/** Postgres truncates identifiers at 63 bytes: the snapshot database is `<db>__ds_snapshot`. */
export const SNAPSHOT_DATABASE_MAX = 50;
/** Databases a snapshot reset never drops. */
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);
/** Keys of a service that only a process sandbox uses. */
const PROCESS_KEYS = ['command', 'cwd', 'env', 'stop_timeout_s'] as const;
const DIR_LABEL = 'the sandbox folder';

export interface SandboxCheckOptions {
  /** Folder of sandbox.yaml: its relative paths resolve against it (undefined: files are not checked). */
  dir?: string;
  /** How its files are looked at (core FileFacts): needed with `dir`. */
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

/** A path written in sandbox.yaml: relative to it. */
function checkRelative(p: unknown, path: IssuePath, what: string, ctx: CheckContext): p is string {
  if (typeof p !== 'string') return false;
  if (machinePath(p)) {
    ctx.error(path, `${what} "${p}" only exists on this computer: write it relative to sandbox.yaml`);
    return false;
  }
  return true;
}

/** The names an env file sets (`NAME=value`, `export NAME=value`; comments and blank lines skipped). */
export function envFileKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * What an env file sets, by name (`NAME=value`, `export NAME=value`), as docker compose reads the common forms: a
 * value in single quotes as it is, one in double quotes with its `\n`, `\"` and `\\` escapes, a bare one trimmed and
 * cut at an inline ` #` comment. The last line of a name wins. No `${VAR}` expansion: a value is taken as written.
 */
export function envFileValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    let value: string;
    const single = /^'([^']*)'/.exec(raw);
    const double = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (single) value = single[1];
    else if (double) value = double[1].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
    else value = raw.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

/** `{{compose_env:NAME}}` as a whole value: an account's username or password read from the sandbox's compose env file. */
const COMPOSE_ENV_REF = /^\s*\{\{\s*compose_env:([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}\s*$/;

/** The name a `{{compose_env:NAME}}` value reads from the sandbox's compose env file; undefined for any other value. */
export function composeEnvRef(value: unknown): string | undefined {
  return typeof value === 'string' ? COMPOSE_ENV_REF.exec(value)?.[1] : undefined;
}

/**
 * The env file of a docker-compose sandbox, absolute (L5.8): `compose.env_file` (relative to sandbox.yaml), else `.env`
 * next to the first compose file when it exists (`exists`: the caller's look at the disk); undefined for none
 * (`env_file: false`, no such file, a process sandbox).
 */
export function composeEnvFilePath(dir: string, manifest: { provider?: unknown; compose?: { files?: readonly string[]; env_file?: unknown } }, exists: (p: string) => boolean): string | undefined {
  const c = manifest.compose;
  if (manifest.provider !== 'docker-compose' || c?.env_file === false) return undefined;
  if (typeof c?.env_file === 'string') return resolve(dir, c.env_file);
  const guess = join(dirname(resolve(dir, (c?.files ?? DEFAULT_COMPOSE_FILES)[0])), '.env');
  return exists(guess) ? guess : undefined;
}

/**
 * The env file of a docker-compose sandbox (L5.8): a written `env_file` must exist; a `COMPOSE_PROFILES` in it (or in the
 * default `.env` next to the first compose file) is refused — docker compose would read it and start other services
 * than sandbox.yaml says (the shell's COMPOSE_* are left out for the same reason).
 */
function checkEnvFile(c: Record<string, unknown>, composeFiles: readonly string[], ctx: CheckContext): void {
  if (!ctx.projectDir || c.env_file === false) return;
  const files = needFiles(ctx.files, 'the env file check');
  let file: string;
  let at: IssuePath;
  if (typeof c.env_file === 'string') {
    if (!checkRelative(c.env_file, ['compose', 'env_file'], 'env file', ctx)) return;
    file = resolve(ctx.projectDir, c.env_file);
    at = ['compose', 'env_file'];
    if (files.kind(file) === undefined) {
      ctx.error(at, `env file "${c.env_file}" not found in ${DIR_LABEL}`);
      return;
    }
  } else {
    if (!composeFiles.length || machinePath(composeFiles[0])) return;
    file = resolve(dirname(resolve(ctx.projectDir, composeFiles[0])), '.env');
    at = Array.isArray(c.files) ? ['compose', 'files', 0] : ['provider'];
    if (files.kind(file) === undefined) return;
  }
  let text: string;
  try {
    text = files.readText(file);
  } catch {
    ctx.error(at, `env file ${file} cannot be read`);
    return;
  }
  if (envFileKeys(text).includes('COMPOSE_PROFILES')) {
    ctx.error(at, `the env file ${typeof c.env_file === 'string' ? `"${c.env_file}"` : 'next to the compose file (.env)'} sets COMPOSE_PROFILES: docker compose would start other services than sandbox.yaml says — remove it (or give \`env_file\` another file)`);
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

/** Texts shorter than this are never masked (core redact: they would mangle every log). */
const MASKED_MIN = 3;

/** Why a plain password cannot be used at all, or null: one shorter than 3 characters is never masked in the logs. */
export function unmaskedPasswordReason(password: string): string | null {
  return password.length < MASKED_MIN
    ? `a plain password shorter than ${MASKED_MIN} characters is never masked in the logs (texts that short would mangle every log): use something like "sandbox-pass-4632"`
    : null;
}

/**
 * Why a plain password is weak for redaction, or null: every occurrence of a password's text is masked as *** in
 * logs, run files and messages, so a short or one-word one masks ordinary words too.
 */
export function weakPasswordReason(password: string): string | null {
  if (password.length < 8 || /^[a-z]+$/i.test(password)) {
    return 'a plain password shorter than 8 characters or made of one word is masked wherever that text appears in the logs (a password "demo" turns every "demo" into ***): use something like "sandbox-pass-4632"';
  }
  return null;
}

/**
 * Why `{{compose_env:NAME}}` cannot be read (null when it can): not a docker-compose sandbox, no env file, the name not
 * set in it. Never the value. Without the sandbox's folder (a text validated alone) only the provider is checked.
 */
function composeEnvProblem(manifest: Record<string, unknown>, name: string, ctx: CheckContext): string | null {
  const dir = ctx.projectDir;
  const ref = `{{compose_env:${name}}}`;
  if (manifest.provider !== 'docker-compose') return `${ref} reads the compose env file of a docker-compose sandbox: this one is not (use {{env:VAR}} or {{keychain:service/account}})`;
  const c = isObj(manifest.compose) ? manifest.compose : undefined;
  if (c?.env_file === false) return `${ref} reads the sandbox's compose env file, and \`compose.env_file: false\` says there is none`;
  if (!dir) return null;
  const facts = needFiles(ctx.files, 'the compose env check');
  const files = Array.isArray(c?.files) ? c.files.filter((f): f is string => typeof f === 'string') : undefined;
  const file = composeEnvFilePath(dir, { provider: 'docker-compose', compose: { ...(files?.length ? { files } : {}), env_file: c?.env_file } }, (p) => facts.kind(p) !== undefined);
  if (!file) return `${ref} reads the sandbox's compose env file, and there is none: write \`compose.env_file\`, or a .env next to the first compose file`;
  let text: string;
  try {
    text = facts.readText(file);
  } catch {
    return null; // checkEnvFile says so
  }
  return Object.hasOwn(envFileValues(text), name) ? null : `${ref}: ${name} is not set in the sandbox's compose env file (${file})`;
}

/** A password that is one secret reference ({{env:VAR}} / {{keychain:…}}): not plain text. */
function isSecretReference(v: string): boolean {
  const t = v.trim();
  return /^\{\{\s*[^{}]+?\s*\}\}$/.test(t) && collectSecretRefs(t).size === 1;
}

/**
 * The services the compose files declare (undefined when they cannot be read); those under `profiles:` are added to
 * `profiled` (a sandbox never starts them: compose runs without COMPOSE_PROFILES).
 */
function composeServices(files: readonly string[], base: IssuePath, written: boolean, ctx: CheckContext, profiled: Set<string>): Set<string> | undefined {
  const out = new Set<string>();
  let complete = true;
  files.forEach((f, i) => {
    const at = written ? [...base, i] : base;
    if (!checkRelative(f, at, 'compose file', ctx)) {
      complete = false;
      return;
    }
    if (!ctx.projectDir) {
      complete = false;
      return;
    }
    const abs = resolve(ctx.projectDir, f);
    const disk = needFiles(ctx.files, 'the compose file check');
    let text: string;
    try {
      text = disk.readText(abs);
    } catch {
      ctx.error(at, `compose file "${f}" not found in ${DIR_LABEL}${written ? '' : ' (compose.files defaults to [compose.yaml])'}`);
      complete = false;
      return;
    }
    let doc: unknown;
    try {
      doc = parseYamlText(text);
    } catch (e) {
      ctx.error(at, `compose file "${f}" is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
      complete = false;
      return;
    }
    if (isObj(doc) && isObj(doc.services)) {
      for (const [name, svc] of Object.entries(doc.services)) {
        out.add(name);
        if (isObj(svc) && Array.isArray(svc.profiles) && svc.profiles.length) profiled.add(name);
      }
    }
  });
  return complete ? out : undefined;
}

/** pg_dump's plain output (COPY … FROM stdin, psql meta-commands): sql steps cannot run it. */
function dumpOutputReason(sql: string): string | null {
  if (/\bFROM\s+stdin\s*;/i.test(sql)) return 'COPY … FROM stdin';
  const meta = /^\s*\\(connect|restrict|unrestrict|c|i|set|copy)\b/m.exec(sql);
  return meta ? `\\${meta[1]}` : null;
}

/** Issue paths of a checkAuth run on the accounts (as one global auth block) → their place in sandbox.yaml. */
function fromAuthPath(path: IssuePath): IssuePath {
  if (path[0] !== 'auth') return path;
  if (path[1] === 'personas' && path.length > 2) return ['accounts', ...path.slice(2)];
  if (path[1] === 'login_url') return path.slice(1);
  if (path.length === 1) return ['accounts'];
  return path.slice(1);
}

/** Sandbox.yaml paths → the auth block checkAuth reads (for its "is this part broken" questions). */
function toAuthPath(path: IssuePath): IssuePath | null {
  if (path[0] === 'accounts') return ['auth', 'personas', ...path.slice(1)];
  if (path[0] === 'login_url') return ['auth', ...path];
  return null;
}

/** The accounts as one global auth block (username / password left out) for checkAuth. */
function accountsAsAuth(value: Record<string, unknown>): Record<string, unknown> {
  const personas: Record<string, unknown> = {};
  if (isObj(value.accounts)) {
    for (const [name, a] of Object.entries(value.accounts)) {
      if (!isObj(a)) {
        personas[name] = a;
        continue;
      }
      const { username: _u, password: _p, ...persona } = a;
      personas[name] = persona;
    }
  }
  return { ...(value.login_url !== undefined ? { login_url: value.login_url } : {}), personas };
}

/** {{account.<field>}} tokens of a value (strings walked recursively). */
function accountFields(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    for (const expr of listTemplateTokens(v)) {
      const m = /^account\.(\w+)$/.exec(expr.trim());
      if (m) out.add(m[1]);
    }
  } else if (Array.isArray(v)) v.forEach((x) => accountFields(x, out));
  else if (isObj(v)) for (const x of Object.values(v)) accountFields(x, out);
  return out;
}

/** Semantic checks of a sandbox.yaml value (schema issues in `structural`). */
export function checkSandbox(value: unknown, structural: readonly LocatedIssue[], opts: SandboxCheckOptions = {}): LocatedIssue[] {
  if (!isObj(value)) return [];
  const ctx = new CheckContext(structural, opts.dir, DIR_LABEL, opts.files);
  const provider = value.provider === 'docker-compose' || value.provider === 'process' ? value.provider : undefined;
  const compose = provider === 'docker-compose';
  const services = isObj(value.services) ? value.services : {};
  const serviceNames = Object.keys(services);
  const config = opts.project?.config;
  const vars = new Set(Object.keys(config?.vars ?? {}));

  // ── The compose files (docker-compose) ──
  let composeNames: Set<string> | undefined;
  const profiled = new Set<string>();
  if (value.compose !== undefined && provider === 'process') {
    ctx.error(['compose'], '`compose` is for provider docker-compose (this sandbox starts local processes)', { path: ['compose'], key: true });
  } else if (compose && !ctx.broken(['compose'])) {
    const c = isObj(value.compose) ? value.compose : {};
    const written = Array.isArray(c.files);
    const files = written ? (c.files as unknown[]).filter((f): f is string => typeof f === 'string') : [...DEFAULT_COMPOSE_FILES];
    composeNames = composeServices(files, written ? ['compose', 'files'] : ['provider'], written, ctx, profiled);
    checkEnvFile(c, files, ctx);
  }

  // ── Services and their pages ──
  const pages = new Map<string, { service: string; url: string; path: IssuePath }>();
  for (const [name, svc] of Object.entries(services)) {
    const sp: IssuePath = ['services', name];
    if (!isObj(svc)) continue;
    if (composeNames && !composeNames.has(name)) {
      ctx.error(['services'], `service "${name}" is not a service of the compose files${suggestion(name, [...composeNames])} (they declare: ${[...composeNames].join(', ') || 'none'})`, { path: sp, key: true });
    } else if (profiled.has(name)) {
      ctx.error(['services'], `service "${name}" has \`profiles:\` in the compose files: a sandbox never starts it (Retake runs docker compose without COMPOSE_PROFILES) — remove its \`profiles\``, { path: sp, key: true });
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
    if (isObj(svc.pages)) {
      for (const [key, pv] of Object.entries(svc.pages)) {
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
    checkHealth(svc, sp, compose, ctx);
  }
  if (!ctx.broken(['services']) && serviceNames.length > 0 && pages.size === 0) {
    ctx.error(['services'], 'a sandbox needs at least one page: add `pages: {app: http://localhost:<port>}` to the service that serves the product', { path: ['services'], key: true });
  }
  const pageKeys = [...pages.keys()];

  // ── The project: no sandbox page on the host and port of a production / read-only page ──
  if (config) {
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

  // ── Template tokens: the sandbox's pages, the project's vars and secret references ──
  const saved = new Set<string>();
  const scope: TokenScope = { pages: pageKeys, vars, varsComplete: config !== undefined, saved, account: 'elsewhere' };

  // ── Databases ──
  const databases = isObj(value.databases) ? value.databases : {};
  for (const [key, db] of Object.entries(databases)) {
    const dp: IssuePath = ['databases', key, 'url'];
    if (!isObj(db) || typeof db.url !== 'string' || ctx.broken(dp)) continue;
    checkDatabaseUrl(db.url, dp, key, ctx);
    const plain = clearTextPassword(db.url);
    const password = plain ? decodeURIComponentSafe(plain.password) : null;
    const unmasked = password === null ? null : unmaskedPasswordReason(password);
    const weak = password === null || unmasked ? null : weakPasswordReason(password);
    if (unmasked) ctx.error(dp, unmasked);
    else if (weak) ctx.warning(dp, weak);
  }

  // ── Seed ──
  if (Array.isArray(value.seed)) {
    const allowConfig = {
      environments: { ...(config?.environments ?? {}), [opts.env ?? 'sandbox']: Object.fromEntries([...pages].map(([k, p]) => [k, p.url])) },
      allow_hosts: config?.allow_hosts,
    };
    const hookList = value.seed.map((step, i) => checkSeedStep(step, ['seed', i], { compose, composeNames, profiled, serviceNames, allowConfig }, ctx));
    // A shell step gets the `env` of the process services (a seed's `npm run db:reset` reaches the sandbox's database):
    // a variable two of them set differently is the step's to set.
    const conflicts = provider === 'process' ? conflictingServiceEnv(services) : new Map<string, string[]>();
    value.seed.forEach((step, i) => {
      if (!conflicts.size || !isObj(step) || step.shell === undefined || ctx.broken(['seed', i])) return;
      const own = isObj(step.shell) && isObj(step.shell.env) ? step.shell.env : {};
      for (const [name, by] of conflicts) {
        if (Object.hasOwn(own, name)) continue;
        ctx.error(['seed', i, 'shell'], `services ${by.join(' and ')} set ${name} differently, and a shell step gets the env of the sandbox's services: set ${name} in the step's own \`env\``);
      }
    });
    checkHooks(hookList, ['seed'], ctx, { pages: pageKeys, saved, project: { config: allowConfig as never }, destructiveOk: true });
    value.seed.forEach((step, i) => {
      if (!ctx.broken(['seed', i])) checkTokens(step, ['seed', i], scope, ctx);
    });
  }

  // ── Reset ──
  if (isObj(value.reset) && !ctx.broken(['reset'])) {
    const r = value.reset;
    const snapshot = r.strategy === 'snapshot';
    if (snapshot) checkSnapshot(r, databases, provider, ctx);
    else if (r.snapshot !== undefined) {
      ctx.warning(['reset', 'snapshot'], '`snapshot` is only used with `strategy: snapshot` (this sandbox reseeds)', { path: ['reset', 'snapshot'], key: true });
    }
    if (Array.isArray(r.restart)) {
      r.restart.forEach((s, i) => {
        if (typeof s === 'string' && !Object.hasOwn(services, s)) {
          ctx.error(['reset', 'restart', i], `unknown service "${s}"${suggestion(s, serviceNames)} (services: ${serviceNames.join(', ') || 'none'})`);
        }
      });
    }
  }

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
  checkAccounts(value, pageKeys, Object.fromEntries([...pages].map(([k, p]) => [k, p.url])), vars, opts.env ?? 'sandbox', ctx);
  return ctx.out;
}

/** Variables two process services set to different values (`env` as written), with the services. */
function conflictingServiceEnv(services: Record<string, unknown>): Map<string, string[]> {
  const seen = new Map<string, Map<string, string[]>>();
  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc) || !isObj(svc.env)) continue;
    for (const [k, v] of Object.entries(svc.env)) {
      if (typeof v !== 'string') continue;
      const byValue = seen.get(k) ?? new Map<string, string[]>();
      byValue.set(v, [...(byValue.get(v) ?? []), name]);
      seen.set(k, byValue);
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, byValue] of seen) if (byValue.size > 1) out.set(k, [...byValue.values()].flat());
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
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
      ctx.error([...hp, 'tcp'], 'a TCP check of a port Docker publishes always succeeds (its proxy accepts the connection): give the compose service a healthcheck, or check an http path', { path: [...hp, 'tcp'], key: true });
    }
    for (const k of ['status', 'text'] as const) {
      if (h[k] !== undefined) ctx.error([...hp, k], `\`${k}\` is for an http health check, not \`tcp\``, { path: [...hp, k], key: true });
    }
  }
  if (h.url !== undefined) checkLoopback(h.url, [...hp, 'url'], 'health url', ctx);
  if (ways.length === 0 || h.path !== undefined) {
    if (typeof h.path === 'string' && !h.path.startsWith('/')) ctx.error([...hp, 'path'], `"${h.path}" is not a path: write "/${h.path}"`);
    else if (typeof h.path === 'string' && leavesOrigin(h.path)) ctx.error([...hp, 'path'], `"${h.path}" could leave the service's url ("//…" names another host, and a "\\" counts as "/"): write a path ("/health")`);
    else if (svc.url === undefined) ctx.error(hp, `an http health check needs the service's \`url\` (or \`url\` here)`);
  }
}

interface SeedContext {
  compose: boolean;
  composeNames: Set<string> | undefined;
  /** Compose services under `profiles:` (never started). */
  profiled: ReadonlySet<string>;
  serviceNames: readonly string[];
  allowConfig: { environments: Record<string, Record<string, string>>; allow_hosts?: string[] };
}

/**
 * One seed step: its paths relative to sandbox.yaml, no rollback (a seed is never undone), SQL that is not a pg_dump
 * plain dump, and `exec` (docker-compose: a compose service; the hosts its command names allowed). Returns the step as
 * checkHooks reads it (null for `exec`, which is not a hook).
 */
function checkSeedStep(step: unknown, p: IssuePath, s: SeedContext, ctx: CheckContext): unknown {
  if (!isObj(step) || ctx.broken(p)) return null;
  if (isObj(step.exec)) {
    const ep: IssuePath = [...p, 'exec'];
    if (!s.compose) {
      ctx.error(ep, '`exec` runs a command inside a compose service (provider docker-compose): with provider process, write a `shell` step (with `cwd`)', { path: ep, key: true });
      return null;
    }
    const svc = step.exec.service;
    const known = s.composeNames ? [...s.composeNames] : [...s.serviceNames];
    if (typeof svc === 'string' && !known.includes(svc)) {
      ctx.error([...ep, 'service'], `unknown service "${svc}"${suggestion(svc, known)} (${s.composeNames ? 'the compose files declare' : 'services'}: ${known.join(', ') || 'none'})`);
    } else if (typeof svc === 'string' && s.profiled.has(svc)) {
      ctx.error([...ep, 'service'], `service "${svc}" has \`profiles:\` in the compose files: a sandbox never starts it, so an exec step cannot run in it — remove its \`profiles\``);
    }
    const cmd = step.exec.command;
    const text = typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd.filter((x) => typeof x === 'string').join(' ') : '';
    const extra = s.composeNames ?? new Set(s.serviceNames);
    for (const r of shellHostRefs(text)) {
      if (r.unresolved || extra.has(r.host) || isHostAllowed(r.host, { config: s.allowConfig as never })) continue;
      ctx.error([...ep, 'command'], `exec names host ${r.host} (${r.via}): a seed only reaches the sandbox's services, localhost and allowed hosts`);
    }
    return null;
  }
  for (const kind of ['http', 'sql', 'shell'] as const) {
    const spec = step[kind];
    if (isObj(spec) && spec.rollback !== undefined) {
      ctx.warning([...p, kind, 'rollback'], 'a seed step is never rolled back (the next reset rebuilds the data): `rollback` is ignored', { path: [...p, kind, 'rollback'], key: true });
    }
  }
  if (step.sql !== undefined) {
    const spec = step.sql as string | { file?: unknown; query?: unknown };
    const src = typeof spec === 'string' ? sqlSource(spec) : { file: typeof spec.file === 'string' ? spec.file : undefined, query: typeof spec.query === 'string' ? spec.query : undefined };
    const fp: IssuePath = typeof spec === 'string' ? [...p, 'sql'] : [...p, 'sql', 'file'];
    let text = src.query;
    if (src.file !== undefined) {
      if (!checkRelative(src.file, fp, 'SQL file', ctx)) return null;
      if (ctx.projectDir) {
        const disk = needFiles(ctx.files, 'the seed SQL check');
        try {
          text = disk.readText(resolve(ctx.projectDir, src.file));
        } catch {
          text = undefined; // reported by checkHooks
        }
      }
    }
    const dump = text === undefined ? null : dumpOutputReason(text);
    if (dump) {
      ctx.error(
        fp,
        `this SQL is pg_dump's plain output (${dump}): sql steps run SQL statements — dump with \`pg_dump --inserts\`, or load it with an \`exec\` step (psql -f inside the database's container)`,
      );
    }
  }
  if (isObj(step.shell) && step.shell.cwd !== undefined) checkRelative(step.shell.cwd, [...p, 'shell', 'cwd'], 'cwd', ctx);
  return step;
}

/** reset.strategy snapshot: a Postgres database of the sandbox's own compose project, never a system one. */
function checkSnapshot(r: Record<string, unknown>, databases: Record<string, unknown>, provider: string | undefined, ctx: CheckContext): void {
  if (provider === 'process') {
    ctx.error(
      ['reset', 'strategy'],
      'snapshot resets need provider docker-compose: the database must belong to the sandbox\'s own compose project (a process sandbox reseeds — strategy: reseed)',
    );
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
  const name = decodeURIComponentSafe(u.pathname.replace(/^\//, ''));
  if (!name) ctx.error(['databases', key, 'url'], `database ${key}: the URL names no database (postgres://…/<db>): a snapshot drops and recreates that database`);
  else if (SYSTEM_DATABASES.has(name.toLowerCase())) {
    ctx.error(['databases', key, 'url'], `database ${key} is "${name}": a snapshot reset drops and recreates its database at every take — give the sandbox a database of its own`);
  } else if (name.length > SNAPSHOT_DATABASE_MAX) {
    ctx.error(['databases', key, 'url'], `database name "${name}" is longer than ${SNAPSHOT_DATABASE_MAX} characters: its snapshot "${name}__ds_snapshot" would be cut by Postgres (63 bytes at most)`);
  }
}

/**
 * The accounts, as the personas of the sandbox's environment: checked like project.yaml `auth` (one block, the
 * sandbox's pages), plus their username / password and the {{account.*}} tokens of their login steps.
 */
function checkAccounts(
  value: Record<string, unknown>,
  pageKeys: readonly string[],
  pageUrls: Record<string, string>,
  vars: ReadonlySet<string>,
  env: string,
  ctx: CheckContext,
): void {
  if (value.accounts === undefined && value.login_url === undefined) return;
  // checkAuth reads the accounts as one global auth block: its paths (and the schema's) are mapped both ways.
  const structural: LocatedIssue[] = [];
  for (const i of ctx.structural) {
    const path = toAuthPath(i.path);
    if (path) structural.push({ ...i, path, ...(i.loc ? { loc: { ...i.loc, path: toAuthPath(i.loc.path) ?? i.loc.path } } : {}) });
  }
  const sub = new CheckContext(structural, ctx.projectDir, DIR_LABEL, ctx.files);
  checkAuth(accountsAsAuth(value), { [env]: Object.fromEntries(pageKeys.map((k) => [k, pageUrls[k]])) }, sub, { vars }, { accounts: true });
  for (const i of sub.out) {
    ctx.out.push({ ...i, path: fromAuthPath(i.path), ...(i.loc ? { loc: { ...i.loc, path: fromAuthPath(i.loc.path) } } : {}) });
  }
  if (!isObj(value.accounts) || ctx.broken(['accounts'])) return;
  for (const [name, a] of Object.entries(value.accounts)) {
    const ap: IssuePath = ['accounts', name];
    if (!isObj(a) || ctx.broken(ap)) continue;
    for (const field of ['username', 'password'] as const) {
      const v = a[field];
      if (typeof v !== 'string' || !v.includes('{{')) continue;
      const fromFile = composeEnvRef(v);
      if (fromFile !== undefined) {
        const problem = composeEnvProblem(value, fromFile, ctx);
        if (problem) ctx.error([...ap, field], problem);
      } else if (!isSecretReference(v)) {
        ctx.error([...ap, field], `a ${field} is plain text or one {{env:VAR}} / {{keychain:service/account}} / {{compose_env:NAME}} reference (it is put into the login steps as is)`);
      }
    }
    if (typeof a.password === 'string' && !a.password.includes('{{')) {
      const unmasked = unmaskedPasswordReason(a.password);
      const weak = unmasked ? null : weakPasswordReason(a.password);
      if (unmasked) ctx.error([...ap, 'password'], unmasked);
      else if (weak) ctx.warning([...ap, 'password'], weak);
    }
    const { login, ...rest } = a;
    if (accountFields(rest).size > 0) checkTokens(rest, ap, { pages: pageKeys, vars, varsComplete: true, saved: new Set(), account: 'elsewhere' }, ctx);
    if (Array.isArray(login) && !ctx.broken([...ap, 'login'])) {
      for (const field of accountFields(login)) {
        if ((field === 'username' || field === 'password') && a[field] === undefined) {
          ctx.error([...ap, 'login'], `the login steps use {{account.${field}}}: give account ${name} a \`${field}\``, { path: [...ap, 'login'], key: true });
        }
      }
    }
  }
}
