/**
 * The shared rules for work an agent can shape (trust `mcp`, core HookTrust): one home for the lists every package
 * applies, so the engine, the hooks and the runner never keep their own copy.
 *
 * Loader variables: environment variables that make a program load code, change the shell it starts or the folders it
 * reads its configuration from, before the command itself runs — node (NODE_OPTIONS, NODE_PATH), the shell (PATH, HOME,
 * ZDOTDIR, XDG_CONFIG_HOME, BASH_ENV, ENV, SHELLOPTS, BASHOPTS, PS4, PROMPT_COMMAND, IFS, CDPATH), the dynamic linker
 * (DYLD_*, LD_*), git (GIT_*), the interpreters (PYTHON*, PERL5LIB, PERL5OPT, RUBYOPT, RUBYLIB, *JAVA*_OPTIONS) and the
 * package managers (npm_config_*, PNPM_*, YARN_*, COREPACK_*).
 */

/** Names of the loader variables (see the module comment). */
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
