/** The words agent-written shell commands are judged by (agent-policy.ts): refused builtins, wrappers, interpreters, package runners, path options. */
/** Builtins refused wherever a command runs them: they change the folder paths resolve from, or run text or a file. */
export const REFUSED_BUILTINS: Record<string, string> = {
  cd: "changes the folder its paths resolve from: set the hook's `cwd` instead",
  pushd: "changes the folder its paths resolve from: set the hook's `cwd` instead",
  popd: "changes the folder its paths resolve from: set the hook's `cwd` instead",
  eval: 'runs text as a command',
  exec: 'replaces the shell with another command',
  command: 'runs a command it is given by name',
  builtin: 'runs a shell builtin it is given by name',
  trap: 'runs text as a command later',
  alias: 'renames a command',
  unalias: 'renames a command',
  hash: 'changes which program a name runs',
  enable: 'changes which program a name runs',
  fc: 'runs earlier commands again',
  source: "runs a file in the hook's own shell: run it with `sh <file>`",
  '.': "runs a file in the hook's own shell: run it with `sh <file>`",
};

/**
 * Programs that run the command that follows their options (`nice cd`, `env eval`, `/usr/bin/command eval`…), and the
 * words a shell reads as a prefix of the command after them: bash's `coproc`, zsh's `noglob`, `nocorrect` and `-` (an
 * `sh` that is bash or zsh reads them so).
 */
export const WRAPPERS = new Set([
  'env',
  'nice',
  'nohup',
  'timeout',
  'gtimeout',
  'time',
  'sudo',
  'doas',
  'stdbuf',
  'caffeinate',
  'ionice',
  'chrt',
  'taskset',
  'setsid',
  'unbuffer',
  'flock',
  'command',
  'builtin',
  'coproc',
  'noglob',
  'nocorrect',
  '-',
]);

/** Builtins that set the variables they name (`export NAME`, `read NAME`, `printf -v NAME`…). */
export const VARIABLE_SETTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'read', 'getopts', 'mapfile', 'readarray', 'let', 'printf', 'unset']);

export const word0 = (w: string) => w.slice(w.lastIndexOf('/') + 1);

export interface Interpreter {
  /** Its command names (the last part of the word). */
  name: RegExp;
  /** An option that gives it code to run in the command itself. */
  code?: RegExp;
}

/** Programs that run a program text: shells, node and its kin, the scripting languages, awk. */
export const INTERPRETERS: Interpreter[] = [
  { name: /^(?:sh|bash|zsh|dash|ksh|mksh|ash|yash|fish|csh|tcsh|busybox)$/, code: /^(?:-[A-Za-z]*c[A-Za-z]*|--command|--init-command)(?:=.*)?$/ },
  { name: /^(?:node|nodejs|bun|tsx|ts-node)$/, code: /^(?:-[ep]+|--eval|--print|-r|--require|--import|--loader|--experimental-loader)(?:=.*)?$/ },
  { name: /^deno$/, code: /^(?:eval|-e|--eval)(?:=.*)?$/ },
  { name: /^(?:python|pypy)[\d.]*$/, code: /^-[A-Za-z]*c[A-Za-z]*$/ },
  { name: /^perl[\d.]*$/, code: /^-[A-Za-z]*[eE]/ },
  { name: /^(?:ruby|lua|luajit)[\d.]*$/, code: /^-[A-Za-z]*e/ },
  { name: /^php[\d.]*$/, code: /^(?:-[rBRE].*|--(?:run|process-begin|process-code|process-end)(?:=.*)?)$/ },
  { name: /^osascript$/, code: /^-[A-Za-z]*e/ },
  { name: /^Rscript$/, code: /^(?:-e|--expr)(?:=.*)?$/ },
  { name: /^(?:pwsh|powershell)$/i, code: /^-(?:c|command|e|ec|encodedcommand)$/i },
  { name: /^(?:awk|gawk|mawk|nawk)$/ },
];

export const interpreterOf = (w: string): Interpreter | undefined => {
  const base = word0(w);
  return INTERPRETERS.find((i) => i.name.test(base));
};

/**
 * Package runners that run a package, downloading it when it is not installed: the program itself (`true`), or the
 * subcommands that do it — refused wherever they appear after the program (`pnpm --filter app dlx x`, `npm -C .. exec`).
 */
export const PACKAGE_RUNNERS: Record<string, readonly string[] | true> = {
  npx: true,
  pnpx: true,
  bunx: true,
  uvx: true,
  npm: ['exec', 'x', 'create', 'init'],
  pnpm: ['dlx', 'create'],
  // (`pnpm exec` runs a program installed in the project: a person's dependency, not a download)
  yarn: ['dlx', 'create'],
  bun: ['x', 'create'],
  pipx: ['run'],
  uv: ['tool'],
};

/** git's global options that take a value as the next word. */
export const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** Options whose value is a folder a program works in, or a file it reads: their bare value is judged as a path. */
export const PATH_OPTIONS = /^(?:-C|-f|--file|--dir|--prefix|--cwd|--chdir|--directory|--git-dir|--work-tree|--config|--rcfile|--init-file)$/;
export const PATH_OPTION_EQ = /^(--file|--dir|--prefix|--cwd|--chdir|--directory|--git-dir|--work-tree|--config|--rcfile|--init-file)=(.*)$/;
