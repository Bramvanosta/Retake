/** The environment rules of agent-policy.ts: the loader variables, and the environment of the programs a job starts. */
import { delimiter, isAbsolute } from 'node:path';
import { isUnder } from './client-path.js';
import { needFiles } from './file-facts.js';
import type { FileFacts, FilesWith } from './file-facts.js';
import { showHiddenChars } from './printable.js';
import type { WorkPolicy } from './work-policy.js';

// ── Loader variables ────────────────────────────────────────────────────────────────────────────────────────────

/** Whether an environment variable name is a plain identifier (`NAME`: letters, digits, `_`, not starting with a digit). */
export const ENV_NAME_PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names of the loader variables (see the module comment of agent-policy.ts). */
export const LOADER_ENV_NAMES: readonly RegExp[] = [
  /^NODE_OPTIONS$/,
  /^NODE_PATH$/,
  /^PATH$/,
  /^HOME$/,
  /^ZDOTDIR$/,
  /^XDG_CONFIG_HOME$/,
  /^BASH_ENV$/,
  /^ENV$/,
  /^SHELLOPTS$/,
  /^BASHOPTS$/,
  /^PS4$/,
  /^PROMPT_COMMAND$/,
  /^IFS$/,
  /^CDPATH$/,
  /^DYLD_/,
  /^LD_/,
  /^GIT_/,
  /^PYTHON/,
  /^PERL5LIB$/,
  /^PERL5OPT$/,
  /^PERLLIB$/,
  /^PERL5DB$/,
  /^BASH_FUNC_/,
  /^GEM_(?:HOME|PATH)$/,
  /^BUNDLE_GEMFILE$/,
  /^LUA_(?:INIT|PATH|CPATH)/,
  /^PHPRC$/,
  /^PHP_INI_SCAN_DIR$/,
  /^CLASSPATH$/,
  /^R_(?:PROFILE|ENVIRON|LIBS)/,
  /^TCLLIBPATH$/,
  /^GOFLAGS$/,
  /^PSQLRC$/,
  /^CURL_HOME$/,
  /^WGETRC$/,
  /^(?:EDITOR|VISUAL|PAGER|BROWSER|MANPAGER)$/,
  /^(?:LESSOPEN|LESSCLOSE)$/,
  /^(?:SSH_ASKPASS|SUDO_ASKPASS)$/,
  /^RUSTC_WRAPPER$/,
  /^(?:MAVEN_OPTS|GRADLE_OPTS|ANT_OPTS)$/,
  /^FPATH$/,
  /^PIP_/,
  /^UV_/,
  /^RUBYOPT$/,
  /^RUBYLIB$/,
  /JAVA\w*_OPTIONS$/,
  // package managers read their settings from these in any case (npm: npm_config_* and NPM_CONFIG_*)
  /^npm_config_/i,
  /^PNPM_/i,
  /^YARN_/i,
  /^COREPACK_/i,
];

/** Whether `name` is a loader variable (see the module comment). */
export function isLoaderEnvName(name: string): boolean {
  return LOADER_ENV_NAMES.some((re) => re.test(name));
}

/** NODE_OPTIONS flags that load a file (a module, a loader, an env file, a config, a snapshot). */
export const NODE_OPTIONS_LOADS =
  /(?:^|\s)(?:-r|--require|--import|--loader|--experimental-loader|--env-file(?:-if-exists)?|--experimental-config-file|--openssl-config|--redirect-warnings|--snapshot-blob)(?:[=\s]|$)/;

/** Loader variables that hold a list of paths node or the dynamic linker loads code from. */
export const LOAD_PATH_ENV = /^(?:NODE_PATH|DYLD_[A-Z_]+|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT)$/;

/** How a LOAD_PATH_ENV variable separates its entries: spaces or colons for LD_PRELOAD, else `delimiter`. */
export function loadPathSeparator(name: string, delimiter: string): RegExp {
  return name === 'LD_PRELOAD' ? /[\s:]+/ : new RegExp(`[${delimiter.replace(/[\\\]^-]/g, '\\$&')}]`);
}

// ── Agent policy: the environment of the programs a job starts ──────────────────────────────────────────────────────

/**
 * What every program a job starts under the agent policy gets of the worker's environment (shell hooks and their
 * rollbacks, `docker` / `docker compose`, a process sandbox's services): the shell's own variables, the locale, the
 * time zone, the proxy and certificate settings — never the rest (a token or a password the person exported in the
 * terminal that started the Studio or the worker). PATH is cleaned (childEnv). HOME is the one loader variable here.
 */
export const CHILD_ENV_BASE: readonly RegExp[] = [
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|TZ)$/,
  /^LC_[A-Z]+$/,
  /^(?:http|https|ftp|all|no)_proxy$/i,
  /^(?:SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/,
];

/**
 * What `docker` also gets on top of CHILD_ENV_BASE, by name: which daemon and context it talks to and how (TLS), its
 * config folder, the API version, the default platform, BuildKit and its progress output — never another DOCKER_*
 * variable (a registry password or token the person exported).
 */
export const DOCKER_CHILD_ENV: readonly RegExp[] = [/^DOCKER_(?:HOST|CONTEXT|CONFIG|CERT_PATH|TLS|TLS_VERIFY|API_VERSION|DEFAULT_PLATFORM|BUILDKIT)$/, /^BUILDKIT_PROGRESS$/];

/** How to give a job's programs another variable: the fix line of every refusal and hint about it. */
export const PASS_ENV_FIX = "a person lists its name in project.yaml `pass_env:` (e.g. `pass_env: [NAME]`), or sets it in the hook's own `env` (`{{env:NAME}}` reads it from the worker's environment)";

/**
 * Why `name` may not be listed in project.yaml `pass_env:` (null when it may): not a plain identifier, or a loader
 * variable (see the module comment) — a job's programs never get one from the worker's environment.
 */
export function passEnvProblem(name: string): string | null {
  if (!ENV_NAME_PLAIN.test(name)) return `"${showHiddenChars(name)}" is not a variable name (letters, digits and _, not starting with a digit)`;
  if (isLoaderEnvName(name)) {
    return `${name} is a loader variable (it makes a program load code or read its settings from elsewhere): a job's programs never get it from the worker's environment — a person-written hook sets it in its own \`env\``;
  }
  return null;
}

export interface ChildEnvFields {
  /** project.yaml `pass_env:`: more names passed on as they are (a loader variable never: passEnvProblem). */
  pass?: readonly string[];
  /** The programs are `docker` / `docker compose`: DOCKER_CHILD_ENV too. */
  docker?: boolean;
  /** The workspace folders no PATH entry may be inside (default none). */
  folders?: readonly string[];
  /** How PATH entries are compared with the folders under any spelling (core FileFacts): required with `folders` (ChildEnvOptions). */
  files?: FileFacts;
}

/** childEnv's options; `files` is required with `folders` (FilesWith). */
export type ChildEnvOptions = ChildEnvFields & FilesWith<'folders'>;

/**
 * The environment a program a job starts gets of `source` under the agent policy: CHILD_ENV_BASE (DOCKER_CHILD_ENV
 * too for docker) and the names of `o.pass`, nothing else. PATH keeps its absolute entries outside the workspace
 * folders only (a relative one resolves in the child's folder, and an agent writes files in the workspace). What the
 * caller adds on top — Retake's own RETAKE_* variables, a hook's declared `env`, a sandbox service's `env` — is its own.
 */
export function childEnv(source: NodeJS.ProcessEnv, o: ChildEnvOptions = {}): Record<string, string> {
  const folders = o.folders ?? [];
  const pass = new Set((o.pass ?? []).filter((n) => passEnvProblem(n) === null));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (CHILD_ENV_BASE.some((re) => re.test(k)) || (o.docker && DOCKER_CHILD_ENV.some((re) => re.test(k))) || pass.has(k)) out[k] = v;
  }
  if (out.PATH !== undefined) {
    const files = folders.length ? needFiles(o.files, 'childEnv') : undefined;
    out.PATH = [...new Set(out.PATH.split(delimiter).filter((p) => p && isAbsolute(p) && !folders.some((f) => isUnder(p, f, files!))))].join(delimiter);
  }
  return out;
}

/** childEnv under a work's agent policy, or null when the policy is off (the child inherits, as a command a person types). */
export function policyChildEnv(policy: WorkPolicy, source: NodeJS.ProcessEnv, o: Omit<ChildEnvOptions, 'folders' | 'files'> & { files: FileFacts }): Record<string, string> | null {
  return policy.agentFolders ? childEnv(source, { ...o, folders: policy.agentFolders }) : null;
}

/**
 * The hint added to a hook that failed under the agent policy: the variables it could see (names only) and how to pass
 * another one.
 */
export function childEnvHint(names: readonly string[]): string {
  const shown = [...new Set(names)].sort();
  return `a job the Studio, the desktop app or an MCP client starts gives its programs only some variables of the worker's environment — this one saw ${shown.join(', ') || 'none'}; if it needs another, ${PASS_ENV_FIX}`;
}

/**
 * The hint added to a rollback Retake did not sign that failed: the variables it could see (names only — it gets
 * CHILD_ENV_BASE of this process's environment and nothing else, `pass_env:` included) and what to do instead.
 */
export function bareEnvHint(names: readonly string[]): string {
  const shown = [...new Set(names)].sort();
  return `a rollback Retake did not sign gets only the shell's own variables of this environment, never project.yaml \`pass_env:\` — this one saw ${shown.join(', ') || 'none'}; if it needs another, run it by hand`;
}
