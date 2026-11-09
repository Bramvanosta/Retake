/**
 * The shared rules for work an agent can shape (trust `mcp`, core HookTrust): one home for the lists every package
 * applies, so the engine, the hooks and the runner never keep their own copy.
 *
 * Loader variables: environment variables that make a program load code, change the shell it starts or the folders it
 * reads its configuration from, before the command itself runs — node (NODE_OPTIONS, NODE_PATH), the shell (PATH, HOME,
 * ZDOTDIR, XDG_CONFIG_HOME, BASH_ENV, ENV, SHELLOPTS, BASHOPTS, PS4, PROMPT_COMMAND, IFS, CDPATH), the dynamic linker
 * (DYLD_*, LD_*), bash's exported functions (BASH_FUNC_*), git (GIT_*), the interpreters (PYTHON*, PERL5LIB, PERLLIB,
 * PERL5OPT, PERL5DB, RUBYOPT, RUBYLIB, GEM_HOME, GEM_PATH, BUNDLE_GEMFILE, LUA_INIT*, LUA_PATH, LUA_CPATH, PHPRC,
 * PHP_INI_SCAN_DIR, CLASSPATH, *JAVA*_OPTIONS, R_PROFILE*, R_ENVIRON*, R_LIBS*, TCLLIBPATH, GOFLAGS), the start files
 * of psql, curl and wget (PSQLRC, CURL_HOME, WGETRC), the programs other tools start (EDITOR, VISUAL, PAGER, MANPAGER,
 * BROWSER, LESSOPEN, LESSCLOSE, SSH_ASKPASS, SUDO_ASKPASS, RUSTC_WRAPPER), the JVM build tools' options (MAVEN_OPTS,
 * GRADLE_OPTS, ANT_OPTS), zsh's function path (FPATH) and the package managers (npm_config_*, PNPM_*, YARN_*,
 * COREPACK_*, PIP_*, UV_*).
 *
 * Agent-written shell commands: a strict grammar — plain words joined by single spaces and ` && ` — read in one pass,
 * then a few rules per word (agentShellProblems, agentShellCwdProblems, agentShellEnvProblems).
 *
 * Navigation: the URLs a scenario opens (navigationProblem, scenarioNavigationProblems), the one origin comparison
 * (canonicalOrigin) and, built on it, the server a URL reaches (canonicalAddress, canonicalIp).
 *
 * Chromium switches: the ones that turn Chromium's OS sandbox or its site isolation off (SANDBOX_OFF_SWITCHES,
 * SITE_ISOLATION_OFF_FEATURES) or open the browser to other code (BROWSER_OPEN_SWITCHES), refused in `browser.args`
 * whoever writes them (sandboxOffArgProblem): every browser Retake launches runs sandboxed. For a job an agent can shape
 * also positional arguments and every switch outside AGENT_ALLOWED_SWITCHES (agentArgProblem).
 *
 * Agent policy: whether this process serves trust `mcp` (useAgentPolicy: the jobs worker, the MCP server, the Studio
 * server — never a command a person types), and under it the programs a job may run (programProblem: none from inside
 * the workspace, none by a relative path; policyProgram also gives the real path to start) and the browser switches it
 * may pass (policyArgsProblems: an allow-list). Also under it, the
 * environment of the programs a job starts: an allow-list of the worker's (childEnv, project.yaml `pass_env:`).
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AGENT_WRITABLE_PATHS, agentWritable, channelWords, realPathOf } from './agent-trust.js';
import type { AgentChannel } from './agent-trust.js';
import { showHiddenChars } from './brand.js';
import { setBundleProgramCheck } from './bundle.js';
import { isUnder } from './client-path.js';
import type { IssuePath } from './issues.js';
import { scenePageEntries, splitPageOpen } from './pages.js';
import { normalizeStep, stepActionKeys } from './steps.js';
import { suggestion } from './validation/suggest.js';

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

// ── Agent-written shell commands ────────────────────────────────────────────────────────────────────────────────────

/** The longest agent-written shell command (`run`, `rollback` or `cwd`, rendered), read before anything else. */
export const AGENT_SHELL_MAX_CHARS = 4_000;

/** The characters of a plain word: letters, digits and `. / : = @ % + , - _`. */
const PLAIN_CHAR = /[A-Za-z0-9./:=@%+,_-]/;
/** A plain word, whole. */
export const PLAIN_WORD = /^[A-Za-z0-9./:=@%+,_-]+$/;

/** What an agent-written shell command is (the refusals end with it). */
export const AGENT_SHELL_GRAMMAR = 'plain words (letters, digits and . / : = @ % + , - _) separated by single spaces, commands joined by ` && `';

/** Whether an environment variable name is a plain identifier (`NAME`: letters, digits, `_`, not starting with a digit). */
export const ENV_NAME_PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `NAME=` (an assignment word, or an `env` / `export` argument) and the variable it sets. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const VARIABLE_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Where agentShellProblems judges the paths of a command. */
export interface AgentShellOptions {
  /** The project folder: a path through one of its agent-writable folders (core AGENT_WRITABLE_PATHS) is refused. */
  projectDir: string;
  /** The folder the command runs in, which relative words resolve from (default projectDir). */
  cwd?: string;
  /** What `~` stands for (default the home folder; agentWritablePath only — a command has no `~`). */
  home?: string;
}

/**
 * Where `path` leads relative to the project (`own`) or to a project beside it (`beside`, `<project>/<rest>`), once
 * symbolic links of its existing part are followed (it need not exist); null outside both. `~` and `~/…` stand for
 * `o.home` unless `tilde: false`; a `file://` URL for its path.
 */
function projectPlace(path: string, o: AgentShellOptions & { tilde?: boolean }): { own: string } | { beside: string; rest: string } | null {
  let p = path.replace(/^file:\/\//i, '');
  if (o.tilde !== false && (p === '~' || p.startsWith('~/'))) p = join(o.home ?? homedir(), p.slice(1));
  const real = realPathOf(resolve(o.cwd ?? o.projectDir, p));
  const below = (base: string): string | undefined => {
    const rel = relative(base, real);
    return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
  };
  const root = realPathOf(resolve(o.projectDir));
  const own = below(root);
  if (own !== undefined) return { own };
  const beside = below(realPathOf(dirname(root)));
  if (beside === undefined) return null;
  const [, ...rest] = beside.split(sep);
  return rest.length ? { beside, rest: rest.join(sep) } : null;
}

/**
 * Where a path an agent-written shell command names leads, when that is through a folder an agent can write (core
 * agentWritable): of the project (`runs/…`, `scenarios/…`, README.md…), or of a project beside it — the agent writes the
 * scenarios of every project of the workspace. Its project-relative form (`runs/x/a.sh`, `../other/runs/a.sh`), else
 * null. Symbolic links of its existing part are followed; it need not exist. `~` and `~/…` stand for `o.home`, a
 * `file://` URL for its path; `tilde: false` takes `~` literally (a hook's cwd).
 */
export function agentWritablePath(path: string, o: AgentShellOptions & { tilde?: boolean }): string | null {
  const at = projectPlace(path, o);
  if (!at) return null;
  if ('own' in at) return agentWritable(at.own) ? at.own.split(sep).join('/') : null;
  return agentWritable(at.rest) ? `../${at.beside.split(sep).join('/')}` : null;
}

/** A person's own file of a project (or of one beside it): `hooks/…` or `project.yaml`, project-relative; else null. */
function personFilePath(path: string, o: AgentShellOptions): { rel: string; file: 'hooks/' | 'project.yaml' } | null {
  const at = projectPlace(path, { ...o, tilde: false });
  if (!at) return null;
  const rel = ('own' in at ? at.own : at.rest).split(sep).join('/').replace(/^(?:\.\/)+/, '');
  const shown = 'own' in at ? rel : `../${at.beside.split(sep).join('/')}`;
  const lower = rel.toLowerCase();
  if (lower === 'project.yaml' || lower === 'project.yml') return { rel: shown, file: 'project.yaml' };
  if (lower === 'hooks' || lower.startsWith('hooks/')) return { rel: shown, file: 'hooks/' };
  return null;
}

/** The folder of agentWritablePath's answer, for a message: "runs/", "README.md", "runs/ of another project". */
function writableFolder(rel: string): string {
  const parts = rel.split('/');
  const folder = (name: string, deeper: boolean) => (deeper || AGENT_WRITABLE_PATHS.includes(`${name.toLowerCase()}/`) ? `${name}/` : name);
  if (parts[0] === '..') return `${folder(parts[2], parts[3] !== undefined)} of another project`;
  return folder(parts[0], parts.length > 1);
}

/** Builtins refused wherever a command runs them: they change the folder paths resolve from, or run text or a file. */
const REFUSED_BUILTINS: Record<string, string> = {
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
const WRAPPERS = new Set(['env', 'nice', 'nohup', 'timeout', 'gtimeout', 'time', 'sudo', 'doas', 'stdbuf', 'caffeinate', 'ionice', 'chrt', 'taskset', 'setsid', 'unbuffer', 'flock', 'command', 'builtin', 'coproc', 'noglob', 'nocorrect', '-']);

/** Builtins that set the variables they name (`export NAME`, `read NAME`, `printf -v NAME`…). */
const VARIABLE_SETTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'read', 'getopts', 'mapfile', 'readarray', 'let', 'printf', 'unset']);

const word0 = (w: string) => w.slice(w.lastIndexOf('/') + 1);

interface Interpreter {
  /** Its command names (the last part of the word). */
  name: RegExp;
  /** An option that gives it code to run in the command itself. */
  code?: RegExp;
}

/** Programs that run a program text: shells, node and its kin, the scripting languages, awk. */
const INTERPRETERS: Interpreter[] = [
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

const interpreterOf = (w: string): Interpreter | undefined => {
  const base = word0(w);
  return INTERPRETERS.find((i) => i.name.test(base));
};

/**
 * Package runners that run a package, downloading it when it is not installed: the program itself (`true`), or the
 * subcommands that do it — refused wherever they appear after the program (`pnpm --filter app dlx x`, `npm -C .. exec`).
 */
const PACKAGE_RUNNERS: Record<string, readonly string[] | true> = {
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
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** Options whose value is a folder a program works in, or a file it reads: their bare value is judged as a path. */
const PATH_OPTIONS = /^(?:-C|-f|--file|--dir|--prefix|--cwd|--chdir|--directory|--git-dir|--work-tree|--config|--rcfile|--init-file)$/;
const PATH_OPTION_EQ = /^(--file|--dir|--prefix|--cwd|--chdir|--directory|--git-dir|--work-tree|--config|--rcfile|--init-file)=(.*)$/;

/** The parts of a word that may name a path: the word, the value after `=`, after `-X`, after `@`, each `:` or `,` part. */
function pathCandidates(w: string): string[] {
  const out = new Set<string>([w]);
  const eq = w.indexOf('=');
  if (eq >= 0) out.add(w.slice(eq + 1));
  if (/^-[^-]./.test(w)) out.add(w.slice(2));
  if (w.startsWith('@')) out.add(w.slice(1));
  for (const c of [...out]) {
    if (c.includes(',')) for (const part of c.split(',')) out.add(part);
  }
  for (const c of [...out]) {
    const e = c.indexOf('=');
    if (e >= 0) out.add(c.slice(e + 1));
  }
  for (const c of [...out]) if (c.includes(':') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(c)) for (const part of c.split(':')) out.add(part);
  return [...out].filter((c) => c !== '');
}

/** How a character is named in a refusal: `x`, a space, or `\u{…}` for a control, invisible or non-ASCII one. */
function shownChar(c: string): string {
  if (c === ' ') return 'a space';
  const code = c.codePointAt(0)!;
  return code < 0x21 || code > 0x7e ? `\`\\u{${code.toString(16)}}\`` : `\`${c}\``;
}

/** How a word is shown in a refusal (a plain word: shown as is, a long one cut — the hook itself is shown in full). */
function shownWord(w: string): string {
  return w.length > 80 ? `${w.slice(0, 77)}…` : w;
}

/**
 * The grammar of an agent-written command, in one pass over its characters: its words, by command; or the problems.
 * Every character is a plain word's, a single space between two words, or the `&&` of ` && ` between two commands.
 */
function plainCommands(text: string): { commands: string[][] } | { problems: string[] } {
  const bad: string[] = [];
  const problems: string[] = [];
  for (const ch of text) {
    if (PLAIN_CHAR.test(ch) || ch === ' ' || ch === '&') continue;
    const shown = shownChar(ch);
    if (!bad.includes(shown)) bad.push(shown);
  }
  if (bad.length) {
    const list = bad.length > 8 ? `${bad.slice(0, 8).join(', ')}…` : bad.join(', ');
    problems.push(`${bad.length === 1 ? 'the character' : 'the characters'} ${list} (only plain words: letters, digits and . / : = @ % + , - _)`);
  }
  const words = text.split(' ');
  if (text === '') problems.push('no command');
  else if (words.some((w) => w === '')) problems.push('two spaces in a row, or a space at its start or end (one space between two words)');
  if (words.some((w) => w.includes('&') && w !== '&&')) problems.push('`&` other than ` && ` between two commands (`&`, `&>`, `a&&b`)');
  const commands: string[][] = [[]];
  for (const w of words) {
    if (w === '&&') commands.push([]);
    else if (w !== '') commands[commands.length - 1].push(w);
  }
  if (text !== '' && commands.some((c) => c.length === 0) && !problems.length) problems.push('` && ` without a command on each side');
  return problems.length ? { problems } : { commands };
}

/** Whether word `i` of a command is where a program reads the script it runs (`sh x.sh`, `awk -f x.awk`, `psql -f x.sql`). */
function runsFileAt(words: readonly string[], i: number, program: number): boolean {
  if (i === program) return true;
  const prev = words[i - 1];
  if (prev === '-f' || prev === '--file' || prev === '-m') return true;
  if (/^(?:--file=|-f.)/.test(words[i])) return true;
  // An interpreter's first word that is not an option: its script.
  for (let k = 0; k < i; k++) {
    if (!interpreterOf(words[k])) continue;
    const first = words.slice(k + 1).findIndex((w) => !w.startsWith('-'));
    return first >= 0 && k + 1 + first === i;
  }
  return false;
}

/** The problems of one command's words (agentShellProblems). */
function commandProblems(words: readonly string[], o: AgentShellOptions, add: (p: string) => void): void {
  let program = 0;
  while (program < words.length && ASSIGNMENT.test(words[program])) program++;

  // Builtins that run text or a file, or rebind names: the program, and any word after a wrapper (`nice -n 1 cd`).
  const wrapped = program < words.length && WRAPPERS.has(word0(words[program]));
  for (let i = program; i < words.length; i++) {
    const base = word0(words[i]);
    if ((i === program || wrapped) && Object.hasOwn(REFUSED_BUILTINS, base)) add(`\`${base}\` (it ${REFUSED_BUILTINS[base]})`);
  }

  // Loader variables it sets: an assignment before the program, an `env` argument, a setter's names.
  const loader = (name: string, assigned = true) => {
    if (isLoaderEnvName(name)) add(`\`${name}${assigned ? '=' : ''}\` (it sets ${name}, a loader variable)`);
  };
  for (let i = 0; i < program; i++) loader(ASSIGNMENT.exec(words[i])![1]);
  words.forEach((w, i) => {
    const base = word0(w);
    if (base === 'env') {
      for (const a of words.slice(i + 1)) {
        const m = ASSIGNMENT.exec(a);
        if (m) loader(m[1]);
        else if (!a.startsWith('-')) break;
      }
    }
    if (VARIABLE_SETTERS.has(base)) {
      const rest = words.slice(i + 1);
      for (const [k, a] of rest.entries()) {
        // printf sets only the name after its `-v`; the others every name and NAME= they list.
        if (base === 'printf') {
          if (rest[k - 1] === '-v' && VARIABLE_WORD.test(a)) loader(a, false);
          continue;
        }
        const m = ASSIGNMENT.exec(a);
        if (m) loader(m[1]);
        else if (VARIABLE_WORD.test(a)) loader(a, false);
      }
    }
  });

  const interpreter = words.some((w) => interpreterOf(w));
  words.forEach((w, i) => {
    const base = word0(w);
    const rest = words.slice(i + 1);
    const spec = interpreterOf(w);
    if (spec) {
      const flag = spec.code ? rest.find((r) => spec.code!.test(r)) : undefined;
      if (flag !== undefined) add(`\`${base} ${flag.replace(/=.*$/, '')}\` (it runs code written in the command) — put the code in a script under hooks/`);
      if (!spec.code && !rest.some((r) => /^(?:-f|--file)/.test(r))) add(`\`${base}\` with a program text (it can run commands) — put the program in a file under hooks/ and pass it with \`-f\``);
      if (/^(?:python|pypy)/.test(base)) {
        rest.forEach((r, k) => {
          const mod = r === '-m' ? rest[k + 1] : /^-m./.test(r) ? r.slice(2) : undefined;
          if (mod !== undefined) pathProblem(mod.split('.').join('/'), o, add, mod, true);
        });
      }
    }
    if (base === 'xargs' || base === 'parallel') add(`\`${base}\` (it runs commands built from its input)`);
    if (base === 'find') {
      const run = rest.find((r) => /^-(?:exec|execdir|ok|okdir)$/.test(r));
      if (run) add(`\`find ${run}\` (it runs a command for each file)`);
    }
    if (base === 'env') {
      const split = rest.find((r) => /^(?:-[A-Za-z]*S|--split-string)/.test(r));
      if (split) add('`env -S` (it splits a string into a command)');
    }
    const runner = PACKAGE_RUNNERS[base];
    if (runner === true) add(`\`${base}\` (it runs a package, downloading it when it is not installed)`);
    else if (runner) {
      const sub = rest.find((r) => runner.includes(r));
      if (sub !== undefined) add(`\`${base} ${sub}\` (it runs a package, downloading it when it is not installed)`);
    }
    if (base === 'deno') {
      const spec2 = rest.find((r) => /^(?:npm|jsr):/.test(r));
      if (spec2) add(`\`deno ${shownWord(spec2)}\` (it runs a package, downloading it when it is not installed)`);
    }
    if (base === 'git') {
      for (let k = 0; k < rest.length && rest[k].startsWith('-'); k++) {
        if (rest[k].startsWith('-c') || rest[k].startsWith('--config-env')) {
          add('`git -c` (a configuration given in the command can run commands)');
          break;
        }
        if (GIT_VALUE_OPTIONS.has(rest[k])) k++;
      }
    }
  });

  // Paths. A person's file (hooks/, project.yaml): any word. A folder an agent can write: a word holding a `/`, a bare
  // word an interpreter may run, the value of a folder or file option (a bare `review` of `pnpm run review` is a name).
  words.forEach((w, i) => {
    if (i === program && !w.includes('/')) return; // a program looked up on PATH
    if (/^\/dev\/(?:stdin|fd\/)|^\/proc\/[^/]+\/fd\//.test(w)) add(`\`${shownWord(w)}\` (a stream read as a file)`);
    const judged = w.includes('/') || interpreter || (i > 0 && PATH_OPTIONS.test(words[i - 1])) || PATH_OPTION_EQ.test(w);
    const runs = runsFileAt(words, i, program);
    for (const c of pathCandidates(w)) pathProblem(c, o, add, w, runs, judged);
  });
}

/** Whether agentWritablePath's answer is one of the files (not folders) an agent writes: README.md of a project. */
function writableFile(rel: string): boolean {
  const inProject = rel.replace(/^\.\.\/[^/]+\//, '').toLowerCase();
  return AGENT_WRITABLE_PATHS.some((w) => !w.endsWith('/') && w.toLowerCase() === inProject);
}

/**
 * A path problem of one candidate: through a folder an agent can write when `judged` (a bare folder name such as
 * `review` of `npm run review` is a name), to one of the files an agent writes (README.md) always — any program may
 * read a bare file name as its script.
 */
function pathProblem(candidate: string, o: AgentShellOptions, add: (p: string) => void, word: string, runs: boolean, judged = true): void {
  const found = agentWritablePath(candidate, { ...o, tilde: false });
  const rel = found !== null && (judged || writableFile(found)) ? found : null;
  if (rel !== null) {
    add(`\`${shownWord(word)}\` (a path through ${writableFolder(rel)}, which an agent can write)`);
    return;
  }
  const person = personFilePath(candidate, o);
  if (!person) return;
  if (person.file === 'project.yaml') add(`\`${shownWord(word)}\` (project.yaml, a person's file)`);
  else if (!runs) add(`\`${shownWord(word)}\` (a path into hooks/, a person's folder, other than the script a command runs)`);
}

/**
 * What an agent-written shell command may not use (trust `mcp`, a hook the agent wrote: its rendered `run` or
 * `rollback`): each problem once, in the order found; empty when none. Length first (AGENT_SHELL_MAX_CHARS), then the
 * grammar in one pass — plain words of letters, digits and `. / : = @ % + , - _`, single spaces, commands joined by
 * ` && ` — so the shell expands, redirects, substitutes and quotes nothing. Then, per command:
 * - `cd`, `pushd`, `popd`, `eval`, `exec`, `command`, `builtin`, `trap`, `alias`, `unalias`, `hash`, `enable`, `fc`,
 *   `source`, `.` as the program (by its last path part: `/usr/bin/command`) or after a wrapper (`nice`, `env`…, and
 *   the shells' prefix words `coproc`, `noglob`, `nocorrect`, `-`);
 * - a loader variable it sets: an assignment before the program, an `env` argument, the names a setter (`export`,
 *   `declare`, `read`, `printf -v`…) lists;
 * - inline interpreter code (a shell's `-c`, `node -e` / `-p` / `--eval` / `-r` / `--import`, `deno eval`,
 *   `python -c`, `perl -e`, `ruby -e`, `php -r`, `osascript -e`…), `awk` without `-f`; `xargs`, `parallel`,
 *   `find -exec`, `env -S`; a package runner (`npx`, `uvx`, `bunx`, `pnpx`) or its subcommand wherever it stands
 *   (`npm exec` / `x` / `create` / `init`, `pnpm dlx` / `create`, `yarn dlx`, `bun x`, `pipx run`, `uv tool`,
 *   `deno npm:…`); `git -c`;
 * - a path (a word holding a `/`; a bare word an interpreter may run, or the value of `-C`, `-f`, `--file`, `--prefix`,
 *   `--cwd`…; the value of `--opt=…`, `-Xvalue`, `@file`, a `:` or `,` list; `python -m`'s module) through a folder an
 *   agent can write (agentWritablePath), whether it exists or not; any word naming a file an agent writes (README.md,
 *   bare or not); project.yaml; hooks/ other than the script a command
 *   runs (its program, an interpreter's script, a `-f` file); `/dev/stdin`, `/dev/fd/…`.
 */
export function agentShellProblems(text: string, o: AgentShellOptions): string[] {
  if (text.length > AGENT_SHELL_MAX_CHARS) return [`${text.length.toLocaleString('en-US')} characters (at most ${AGENT_SHELL_MAX_CHARS.toLocaleString('en-US')})`];
  const parsed = plainCommands(text);
  if ('problems' in parsed) return parsed.problems;
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  for (const words of parsed.commands) commandProblems(words, o, add);
  return out;
}

/**
 * What an agent-written hook's working folder (`cwd`, rendered) may not be: over AGENT_SHELL_MAX_CHARS, other than one
 * plain word, or through a folder an agent can write. Empty when none.
 */
export function agentShellCwdProblems(cwd: string, o: AgentShellOptions): string[] {
  if (cwd.length > AGENT_SHELL_MAX_CHARS) return [`its working folder: ${cwd.length.toLocaleString('en-US')} characters (at most ${AGENT_SHELL_MAX_CHARS.toLocaleString('en-US')})`];
  if (!PLAIN_WORD.test(cwd)) return [`its working folder \`${shownWord(showHiddenChars(cwd).replace(/\n/g, '\\u{a}'))}\` (one plain word: letters, digits and . / : = @ % + , - _)`];
  const rel = agentWritablePath(cwd, { ...o, tilde: false });
  return rel !== null ? [`its working folder \`${shownWord(cwd)}\` (a path through ${writableFolder(rel)}, which an agent can write)`] : [];
}

/**
 * The environment variable names an agent-written shell hook may not give its `env` (trust `mcp`): a name that is not a
 * plain identifier (ENV_NAME_PLAIN), or a loader variable. Each once, in order; empty: none.
 */
export function agentShellEnvProblems(env: Readonly<Record<string, string>> | undefined): string[] {
  const out: string[] = [];
  for (const name of Object.keys(env ?? {})) {
    if (!ENV_NAME_PLAIN.test(name)) out.push(`its env name \`${shownWord(showHiddenChars(name).replace(/\n/g, '\\u{a}'))}\` (letters, digits and _, not starting with a digit)`);
    else if (isLoaderEnvName(name)) out.push(`its env \`${name}\` (a loader variable)`);
  }
  return out;
}

// ── Chromium switches ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Chromium switches (without their leading dashes) that turn the OS sandbox off for some or all of its child processes
 * (renderers, GPU, utilities), run them inside the unsandboxed browser process, or turn site isolation off. Always
 * refused in `browser.args`.
 */
export const SANDBOX_OFF_SWITCHES: readonly string[] = [
  'no-sandbox',
  'disable-setuid-sandbox',
  'disable-gpu-sandbox',
  'disable-namespace-sandbox',
  'disable-seccomp-filter-sandbox',
  'no-zygote',
  'no-zygote-sandbox',
  'single-process',
  'in-process-gpu',
  'disable-site-isolation-trials',
];

/**
 * The switches of SANDBOX_OFF_SWITCHES that act on Linux only (its setuid and namespace sandboxes, seccomp, the zygote):
 * on macOS Chromium has none of these, and a launcher that passes one (Remotion passes `--no-zygote`) leaves the
 * sandbox on. Still refused in `browser.args` everywhere.
 */
export const LINUX_ONLY_SANDBOX_SWITCHES: readonly string[] = ['disable-setuid-sandbox', 'disable-namespace-sandbox', 'disable-seccomp-filter-sandbox', 'no-zygote', 'no-zygote-sandbox'];

/**
 * Chromium switches (without their leading dashes) that open the browser to other code while its sandbox stays on: the
 * same-origin policy turned off, a program of the switch's choosing started in place of (or in front of) its child
 * processes, a debugging port any local program can drive. Always refused in `browser.args` (with SANDBOX_OFF_SWITCHES),
 * and a launched browser whose command line holds one is refused like an unsandboxed one.
 */
export const BROWSER_OPEN_SWITCHES: Readonly<Record<string, string>> = {
  'disable-web-security': "turns Chromium's same-origin policy off",
  'renderer-cmd-prefix': "starts Chromium's renderers through another program",
  'gpu-launcher': "starts Chromium's GPU process through another program",
  'utility-cmd-prefix': "starts Chromium's utility processes through another program",
  'browser-subprocess-path': "starts Chromium's child processes from another program",
  'remote-debugging-port': 'opens a debugging port any program of this machine can drive the browser through',
  'remote-debugging-address': 'opens a debugging port any program of this machine can drive the browser through',
};

/** Chromium features whose `--disable-features=` entry turns site isolation off (compared without case, `-` or `_`). */
export const SITE_ISOLATION_OFF_FEATURES: readonly string[] = ['IsolateOrigins', 'SitePerProcess'];

const featureKey = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '');

/**
 * Why `arg` may not be passed to Chromium (null when it may): a switch of SANDBOX_OFF_SWITCHES or BROWSER_OPEN_SWITCHES,
 * or a `--disable-features=` list naming a feature of SITE_ISOLATION_OFF_FEATURES. Read as Chromium reads its command
 * line on macOS and Linux — `--name` or `-name`, a value after `=` — and more broadly (any case, spaces around it), so a
 * spelling Chromium would ignore is refused too.
 */
export function sandboxOffArgProblem(arg: string): string | null {
  const off = sandboxSwitchOff(arg);
  if (off) return off;
  const m = SWITCH.exec(arg);
  const name = m?.[1].toLowerCase();
  if (name && Object.hasOwn(BROWSER_OPEN_SWITCHES, name)) return `--${name} ${BROWSER_OPEN_SWITCHES[name]} — Retake's browsers never run with it: remove it from browser.args`;
  return null;
}

/** A switch as Chromium reads it on macOS and Linux, more broadly (any case, spaces around it): its name, its value. */
const SWITCH = /^\s*--?([^=\s]+)(?:=(.*))?$/s;
const SWITCH_FIX = 'every browser Retake launches runs sandboxed: remove it from browser.args';

/**
 * Why `arg` turns Chromium's OS sandbox or its site isolation off (null when it does not): a switch of
 * SANDBOX_OFF_SWITCHES, or a `--disable-features=` list naming a feature of SITE_ISOLATION_OFF_FEATURES — the narrower
 * reading of sandboxOffArgProblem, for a browser whose launcher passes other switches of its own (the render browser).
 * With `o.platform` other than linux, a switch of LINUX_ONLY_SANDBOX_SWITCHES does not (it has no effect there).
 */
export function sandboxSwitchOff(arg: string, o: { platform?: string } = {}): string | null {
  const m = SWITCH.exec(arg);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const fix = SWITCH_FIX;
  if (o.platform !== undefined && o.platform !== 'linux' && LINUX_ONLY_SANDBOX_SWITCHES.includes(name)) return null;
  if (SANDBOX_OFF_SWITCHES.includes(name)) {
    const what = name === 'disable-site-isolation-trials' ? "Chromium's site isolation" : "Chromium's sandbox";
    return `--${name} turns ${what} off — ${fix}`;
  }
  if (name === 'disable-features' && m[2] !== undefined) {
    const off = SITE_ISOLATION_OFF_FEATURES.map(featureKey);
    for (const entry of m[2].split(',')) {
      const feature = entry.replace(/[<:].*$/s, '').replace(/^\s*\*?/, '').trim();
      if (feature && off.includes(featureKey(feature))) return `--disable-features=${showHiddenChars(feature)} turns Chromium's site isolation off — ${fix}`;
    }
  }
  return null;
}

/** sandboxOffArgProblem for each argument of a list, with its index. */
export function sandboxOffArgsProblems(args: readonly string[]): Array<{ index: number; message: string }> {
  const out: Array<{ index: number; message: string }> = [];
  args.forEach((a, index) => {
    const message = typeof a === 'string' ? sandboxOffArgProblem(a) : null;
    if (message) out.push({ index, message });
  });
  return out;
}

/**
 * The Chromium switches (without their leading dashes) `browser.args` of a job an agent can shape (agent policy, below)
 * may hold, besides the always-refused ones (sandboxOffArgProblem): the window and the screen, the language, colours
 * and fonts, the GPU, timers and background work, first-run screens, media autoplay and fake capture devices, the
 * proxy and the host resolver, WebRTC and QUIC, features. Any other switch is refused — a list of what is safe rather
 * than of what is not, since Chromium has many switches that load code or a profile, write logs, dumps or traces where
 * they say, trust other certificates or open a page or a debugging channel. A command a person types keeps every
 * switch but the always-refused ones.
 */
export const AGENT_ALLOWED_SWITCHES: readonly string[] = [
  // window, screen, language
  'window-size',
  'window-position',
  'start-maximized',
  'hide-scrollbars',
  'force-device-scale-factor',
  'lang',
  'accept-lang',
  // colours, fonts, motion
  'force-color-profile',
  'force-dark-mode',
  'blink-settings',
  'force-prefers-reduced-motion',
  'force-prefers-no-reduced-motion',
  'font-render-hinting',
  'disable-font-subpixel-positioning',
  'disable-lcd-text',
  'disable-smooth-scrolling',
  // GPU and frames
  'use-gl',
  'use-angle',
  'disable-gpu',
  'disable-gpu-compositing',
  'enable-gpu-rasterization',
  'ignore-gpu-blocklist',
  'disable-frame-rate-limit',
  'disable-gpu-vsync',
  // timers and background work
  'disable-background-timer-throttling',
  'disable-backgrounding-occluded-windows',
  'disable-renderer-backgrounding',
  'disable-hang-monitor',
  'disable-ipc-flooding-protection',
  'disable-component-update',
  'disable-domain-reliability',
  'disable-sync',
  'disable-dev-shm-usage',
  // first-run screens, prompts
  'no-first-run',
  'no-default-browser-check',
  'disable-notifications',
  'disable-popup-blocking',
  'disable-prompt-on-repost',
  // media
  'autoplay-policy',
  'mute-audio',
  'use-fake-device-for-media-stream',
  // network
  'proxy-server',
  'proxy-bypass-list',
  'no-proxy-server',
  'host-resolver-rules',
  'webrtc-ip-handling-policy',
  'force-webrtc-ip-handling-policy',
  'disable-quic',
  // features
  'enable-features',
  'disable-features',
  'enable-blink-features',
  'disable-blink-features',
];

/**
 * Chromium features a job an agent can shape may not name in `--enable-features=` (`enable`) or `--disable-features=`
 * (`disable`) — the ones that move the network service out of its sandbox — besides SITE_ISOLATION_OFF_FEATURES
 * (always refused). Compared without case, `-` or `_`.
 */
export const AGENT_REFUSED_FEATURES: Readonly<{ enable: readonly string[]; disable: readonly string[] }> = {
  enable: ['NetworkServiceInProcess', 'NetworkServiceInProcess2'],
  disable: ['NetworkServiceSandbox'],
};

const AGENT_ARGS_FIX = 'jobs the Studio, the desktop app or an MCP client start pass Chromium only the switches of a short list (see `browser.args` in the workspace guide): remove it from browser.args (a run typed in a terminal keeps it)';

/**
 * Why `arg` may not be passed to Chromium for a job an agent can shape (null when it may), besides
 * sandboxOffArgProblem: an argument that is not a switch (`--name` or `--name=value`; Chromium opens anything else as a
 * page or a file when it starts, and reads everything after `--` so), a switch that is not one of
 * AGENT_ALLOWED_SWITCHES, or a feature list naming one of AGENT_REFUSED_FEATURES.
 */
export function agentArgProblem(arg: string): string | null {
  const m = typeof arg === 'string' ? SWITCH.exec(arg) : null;
  const name = m?.[1].toLowerCase();
  if (!m || !name || name.startsWith('-')) {
    const shown = typeof arg === 'string' ? showHiddenChars(arg.length > 80 ? `${arg.slice(0, 77)}…` : arg) : String(arg);
    return `"${shown}" is not a switch (Chromium opens such an argument as a page or a file) — ${AGENT_ARGS_FIX}`;
  }
  if (!AGENT_ALLOWED_SWITCHES.includes(name)) {
    const shown = showHiddenChars(name.length > 60 ? `${name.slice(0, 57)}…` : name);
    return `--${shown} is not one of the switches these jobs may pass — ${AGENT_ARGS_FIX}`;
  }
  const side = name === 'enable-features' ? 'enable' : name === 'disable-features' ? 'disable' : null;
  if (side && m[2] !== undefined) {
    const refused = AGENT_REFUSED_FEATURES[side].map(featureKey);
    for (const entry of m[2].split(',')) {
      const feature = entry.replace(/[<:].*$/s, '').replace(/^\s*\*?/, '').trim();
      if (feature && refused.includes(featureKey(feature))) return `--${name}=${showHiddenChars(feature)} takes Chromium's network service out of its sandbox — ${AGENT_ARGS_FIX}`;
    }
  }
  return null;
}

/** agentArgProblem for each argument of a list, with its index. */
export function agentArgsProblems(args: readonly string[]): Array<{ index: number; message: string }> {
  const out: Array<{ index: number; message: string }> = [];
  args.forEach((a, index) => {
    const message = agentArgProblem(a);
    if (message) out.push({ index, message });
  });
  return out;
}

// ── Agent policy: the process serves trust mcp ────────────────────────────────────────────────────────────────────

/**
 * The folders of the workspace whose jobs an agent can shape in this process, or null. On in a process that serves
 * trust `mcp`: the jobs worker and its job processes (they run every job alike, whoever submitted it — the Studio's
 * and the desktop app's included), the MCP server and the Studio server. Off in a command a person types (the CLI).
 * engine `openWorkspace` sets or clears it each time it opens a workspace (a process serves one).
 */
let agentFolders: string[] | null = null;

/** Turn the agent policy on for these workspace folders (workspaceFolders), or off (null). */
export function useAgentPolicy(folders: readonly string[] | null): void {
  agentFolders = folders ? [...new Set(folders.map((f) => resolve(f)))] : null;
  setBundleProgramCheck(agentFolders ? (program, what) => policyProgram(program, what) : null);
}

/** The workspace folders of the agent policy, or null when this process does not serve trust `mcp`. */
export function agentPolicyFolders(): readonly string[] | null {
  return agentFolders;
}

/** The folders an agent can write in a workspace: its root and its projects, templates and components folders. */
export function workspaceFolders(ws: { root: string; projectsDir?: string; templatesDir?: string; componentsDir?: string }): string[] {
  return [...new Set([ws.root, ws.projectsDir, ws.templatesDir, ws.componentsDir].filter((f): f is string => !!f).map((f) => resolve(f)))];
}

/** The file a bare command name runs, read from `path` as a spawn does: the first entry holding an executable file. */
function onPath(name: string, path: string, exists: (p: string) => boolean): { file: string; entry: string } | null {
  for (const raw of path.split(delimiter)) {
    // An empty entry is the current folder (POSIX).
    const entry = raw === '' ? '.' : raw;
    const file = resolve(entry, name);
    if (exists(file)) return { file, entry };
  }
  return null;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ProgramPolicyOptions {
  /** The PATH a bare command name is looked up in (default: this process's). */
  path?: string;
  /** Whether a file is an executable file (default: the file system's answer). */
  exists?: (p: string) => boolean;
}

/**
 * Why the program `program`, named by `what` (`browser.executable`, `$RETAKE_FFMPEG`, …), may not run for a job of a
 * workspace whose folders are `folders` (null when it may): a relative path (it names another file in each process's
 * folder), or a path inside one of the folders, under any spelling or through a link — an agent writes files there.
 * A bare command name is looked up in the PATH: the folder that holds it may not be relative or inside the workspace
 * either. An absolute path elsewhere, or a command found elsewhere on the PATH, may.
 */
export function agentProgramProblem(program: string, what: string, folders: readonly string[], o: ProgramPolicyOptions = {}): string | null {
  return agentProgram(program, what, folders, o).problem;
}

/**
 * agentProgramProblem, and the file to start when it says nothing: the real path of the program it checked (for a bare
 * command name, of the file the PATH finds), links followed — so a link changed after the check starts nothing else.
 * A bare name the PATH does not find, and a refused program, are given back as they are.
 */
export function agentProgram(program: string, what: string, folders: readonly string[], o: ProgramPolicyOptions = {}): { program: string; problem: string | null } {
  const p = program.trim();
  const refused = (problem: string) => ({ program, problem });
  if (!p) return { program, problem: null };
  const shown = showHiddenChars(p);
  const runs = 'jobs the Studio, the desktop app or an MCP client start run programs from outside the workspace only (an agent can write files in it)';
  if (!isAbsolute(p)) {
    if (p.includes('/')) return refused(`${what} (${shown}) is a relative path — ${runs}: give the absolute path of a program outside the workspace`);
    const found = onPath(p, o.path ?? process.env.PATH ?? '', o.exists ?? isExecutableFile);
    if (!found) return { program, problem: null };
    if (!isAbsolute(found.entry)) return refused(`${what} (${shown}) is found through the relative PATH folder "${showHiddenChars(found.entry)}" — ${runs}: remove that folder from PATH, or give the absolute path of a program outside the workspace`);
    const inside = folders.find((f) => isUnder(found.file, f));
    if (inside) return refused(`${what} (${shown}) is found on PATH at ${showHiddenChars(found.file)}, inside the workspace (${inside}) — ${runs}: remove that folder from PATH, or give the absolute path of a program outside the workspace`);
    return { program: realPathOf(found.file), problem: null };
  }
  const inside = folders.find((f) => isUnder(p, f));
  if (inside) return refused(`${what} (${shown}) lies inside the workspace (${inside}) — ${runs}: move the program out of the workspace and point ${what} at its new place`);
  return { program: realPathOf(p), problem: null };
}

/** agentProgramProblem under this process's agent policy: null when the policy is off (a command a person types). */
export function programProblem(program: string, what: string, o: ProgramPolicyOptions = {}): string | null {
  return agentFolders ? agentProgramProblem(program, what, agentFolders, o) : null;
}

/**
 * agentProgram under this process's agent policy: the real path to start, or the refusal. Policy off (a command a
 * person types): the program as given, never refused.
 */
export function policyProgram(program: string, what: string, o: ProgramPolicyOptions = {}): { program: string; problem: string | null } {
  return agentFolders ? agentProgram(program, what, agentFolders, o) : { program, problem: null };
}

/** agentArgsProblems under this process's agent policy: none when the policy is off. */
export function policyArgsProblems(args: readonly string[]): Array<{ index: number; message: string }> {
  return agentFolders ? agentArgsProblems(args) : [];
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
export const DOCKER_CHILD_ENV: readonly RegExp[] = [
  /^DOCKER_(?:HOST|CONTEXT|CONFIG|CERT_PATH|TLS|TLS_VERIFY|API_VERSION|DEFAULT_PLATFORM|BUILDKIT)$/,
  /^BUILDKIT_PROGRESS$/,
];

/** How to give a job's programs another variable: the fix line of every refusal and hint about it. */
export const PASS_ENV_FIX = 'a person lists its name in project.yaml `pass_env:` (e.g. `pass_env: [NAME]`), or sets it in the hook\'s own `env` (`{{env:NAME}}` reads it from the worker\'s environment)';

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

export interface ChildEnvOptions {
  /** project.yaml `pass_env:`: more names passed on as they are (a loader variable never: passEnvProblem). */
  pass?: readonly string[];
  /** The programs are `docker` / `docker compose`: DOCKER_CHILD_ENV too. */
  docker?: boolean;
  /** The workspace folders no PATH entry may be inside (default: the agent policy's, else none). */
  folders?: readonly string[];
}

/**
 * The environment a program a job starts gets of `source` under the agent policy: CHILD_ENV_BASE (DOCKER_CHILD_ENV
 * too for docker) and the names of `o.pass`, nothing else. PATH keeps its absolute entries outside the workspace
 * folders only (a relative one resolves in the child's folder, and an agent writes files in the workspace). What the
 * caller adds on top — Retake's own RETAKE_* variables, a hook's declared `env`, a sandbox service's `env` — is its own.
 */
export function childEnv(source: NodeJS.ProcessEnv, o: ChildEnvOptions = {}): Record<string, string> {
  const folders = o.folders ?? agentFolders ?? [];
  const pass = new Set((o.pass ?? []).filter((n) => passEnvProblem(n) === null));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (CHILD_ENV_BASE.some((re) => re.test(k)) || (o.docker && DOCKER_CHILD_ENV.some((re) => re.test(k))) || pass.has(k)) out[k] = v;
  }
  if (out.PATH !== undefined) {
    out.PATH = [...new Set(out.PATH.split(delimiter).filter((p) => p && isAbsolute(p) && !folders.some((f) => isUnder(p, f))))].join(delimiter);
  }
  return out;
}

/** childEnv under this process's agent policy, or null when the policy is off (the child inherits, as a command a person types). */
export function policyChildEnv(source: NodeJS.ProcessEnv, o: Omit<ChildEnvOptions, 'folders'> = {}): Record<string, string> | null {
  return agentFolders ? childEnv(source, { ...o, folders: agentFolders }) : null;
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

// ── Navigation ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The origin of an http(s) URL as a browser compares origins (`scheme://host[:port]`: lower case, the default port
 * left out, a trailing dot of the host kept), parsed as WHATWG URL does (leading spaces and tabs ignored); null for any
 * other scheme and for text that is not a URL. The one origin every rule compares (environment pages, inspections,
 * recordings, an agent's navigations).
 */
export function canonicalOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
}

/** An IPv4-mapped IPv6 address as WHATWG URL writes it (`::ffff:7f00:1`): its two last groups are the IPv4 address. */
const MAPPED_IPV6 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * An IP literal in the one form addresses are compared in, or null when the host is a name: an IPv4 address dotted
 * (`127.1`, `0x7f000001` read as WHATWG URL reads them), an IPv6 one compressed in lower case without brackets, and an
 * IPv4-mapped IPv6 address (`[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`) as its IPv4 form — the same server, which a
 * browser still counts as another origin. For guards that ask whether two URLs reach one server (another project's
 * production hosts); origins stay canonicalOrigin's, allow-lists and IP classes their own normalisation.
 */
export function canonicalIp(host: string): string | null {
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h || /[\s/?#@[\]\\]/.test(h)) return null;
  let parsed: string;
  try {
    parsed = new URL(`http://${h.includes(':') ? `[${h}]` : h}/`).hostname;
  } catch {
    return null;
  }
  if (parsed.startsWith('[')) {
    const v6 = parsed.slice(1, -1);
    const m = MAPPED_IPV6.exec(v6);
    if (!m) return v6;
    const [hi, lo] = [parseInt(m[1], 16), parseInt(m[2], 16)];
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed) ? parsed : null;
}

/**
 * The server an http(s) URL reaches, from its canonicalOrigin: the host lower case without a trailing dot, an IP
 * literal in canonicalIp form (`ip`), and the port (the scheme's default when the URL leaves it out); null for any other
 * scheme and for text that is not a URL.
 */
export function canonicalAddress(url: string): { host: string; port: string; ip: boolean } | null {
  const origin = canonicalOrigin(url);
  if (origin === null) return null;
  const u = new URL(origin);
  const ip = canonicalIp(u.hostname);
  const host = ip ?? (u.hostname.endsWith('.') ? u.hostname.slice(0, -1) : u.hostname);
  return { host, port: u.port || (u.protocol === 'https:' ? '443' : '80'), ip: ip !== null };
}

/** A host no URL names: the base a reference without a scheme is resolved against, to tell a path from `//host/…`. */
const PROBE_BASE = 'http://navigation-probe.invalid/';

/** A URL as a message shows it: without its `user:password@`, hidden characters written out, a long one cut. */
function shownUrl(url: string, parsed?: URL): string {
  let v: string;
  if (parsed && (parsed.username || parsed.password)) {
    const copy = new URL(parsed.href);
    copy.username = '';
    copy.password = '';
    v = copy.href;
  } else v = parsed ? url.trim() : url;
  v = showHiddenChars(v.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1')).replace(/[\n\r\t]/g, ' ');
  return v.length > 120 ? `${v.slice(0, 117)}…` : v;
}

/** A scheme at the start of a URL as WHATWG URL reads one (leading spaces and control characters ignored). */
const SCHEME_PREFIX = /^[\u0000-\u0020]*([a-z][a-z0-9+.-]*):/i;

/** How a scenario names the page it means instead, said by every scheme refusal. */
const NAVIGATION_FIX = 'write the http(s) URL of the page, or a path of an environment page (`/…`)';

export interface NavigationOptions {
  /**
   * The origins of the run's environment pages (canonicalOrigin; core pageOrigins): an absolute URL must have one of
   * them exactly, and a reference without a scheme (`//host/…`) is refused (trust `mcp`: work an agent wrote).
   * Undefined: the scheme rule only.
   */
  origins?: readonly string[];
  /** The environment's name, for the message. */
  envName?: string;
  /** The wording's channel (agent work: "through MCP" / "from the Studio"). */
  via?: AgentChannel;
}

/**
 * Why a scenario may not open `url` (null when it may), read as WHATWG URL parses it — as the browser will: leading
 * spaces and control characters ignored, tabs and line breaks dropped, the scheme in any case. Every scenario opens
 * only `http:`, `https:` or exactly `about:blank`, never with sign-in details (`user@`) in the URL. With `o.origins`
 * (work an agent wrote), an absolute URL must have the exact origin of one of the environment's pages — another port of
 * localhost is another app — and `//host/…` is refused. A path (`/x`, `x`, `?q`) is resolved against a page of the
 * environment (or the current page) when it runs: accepted here. Text that is not a URL is not judged (nothing opens).
 * Templated text (`{{…}}`) is judged once rendered, when it runs.
 */
export function navigationProblem(url: string, o: NavigationOptions = {}): string | null {
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    /* not an absolute URL: a path, resolved when it runs */
  }
  if (!u) {
    let r: URL;
    try {
      r = new URL(url, PROBE_BASE);
    } catch {
      // A scheme no browser can read the rest of (`http://exa mple/`, `file://%zz`) is not opened: refused, not left to
      // the run. Other text that is not a URL is not judged here (the run cannot resolve it either).
      const scheme = SCHEME_PREFIX.exec(url.replace(/[\t\n\r]/g, ''))?.[1];
      return scheme ? `${shownUrl(url)} is not a URL a browser can read (${scheme.toLowerCase()}: then text that does not parse) — ${NAVIGATION_FIX}` : null;
    }
    if (r.host === new URL(PROBE_BASE).host) return null;
    if (r.username || r.password) return credentialsProblem(shownUrl(url, r));
    if (!o.origins) return null;
    return `${shownUrl(url, r)} names a host without a scheme (\`//host/…\`): write the full http(s) URL of an environment page, or a path that starts with a single \`/\``;
  }
  const shown = shownUrl(url, u);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    if (u.protocol === 'about:' && u.href === 'about:blank') return null;
    const what = u.protocol === 'about:' ? `${u.href.slice(0, 40)}` : `${/^[aeiou]/.test(u.protocol) ? 'an' : 'a'} ${u.protocol} URL`;
    return `${shown} opens ${what}: a scenario opens only http: and https: pages (or about:blank) — ${NAVIGATION_FIX}`;
  }
  if (u.username || u.password) return credentialsProblem(shown);
  if (o.origins && !o.origins.includes(u.origin)) {
    const env = o.envName !== undefined ? `environment ${o.envName}` : 'the environment';
    return (
      `${shown} is on ${u.origin}, not an origin of ${env}'s pages (${o.origins.join(', ') || 'none'}): ${channelWords(o.via)} a scenario opens ` +
      `only its environment's own origins (another port of localhost is another app) — to film this site, add its origin as a page of ${env} in project.yaml (a person edits it)`
    );
  }
  return null;
}

function credentialsProblem(shown: string): string {
  return `${shown} holds sign-in details (\`user@\`): a scenario's URL never does — remove them (a persona signs in: personas in project.yaml)`;
}

/** A URL a scenario opens: where it is written, its text, and whether `<page>:/path` (a page of the environment) is a form of it. */
export interface NavigationRef {
  path: IssuePath;
  url: string;
  /** A multi-page scene's `pages.<id>.open`: `<page>:/path` names a page of the environment. */
  pagePrefix: boolean;
}

/**
 * Every URL a scenario writes for the browser to open, as written (tolerant: any parsed value): a scene's `open`, each
 * `open` of a multi-page scene's `pages`, an `open` step (`open: …` or `open: {url}`), a `new_tab` step's href
 * (`new_tab: {href}`, or `new_tab: "/…"`) — skipped scenes included.
 */
export function scenarioNavigationRefs(sc: unknown): NavigationRef[] {
  const out: NavigationRef[] = [];
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const scenes = obj(sc) && Array.isArray(sc.scenes) ? sc.scenes : [];
  scenes.forEach((entry: unknown, i) => {
    if (!obj(entry) || 'card' in entry || 'interstitial' in entry) return;
    const p: IssuePath = ['scenes', i];
    if (typeof entry.open === 'string') out.push({ path: [...p, 'open'], url: entry.open, pagePrefix: false });
    if (obj(entry.pages) || Array.isArray(entry.pages)) {
      for (const e of scenePageEntries(entry.pages as never)) {
        if (obj(e.spec) && typeof e.spec.open === 'string') out.push({ path: [...p, ...e.path, 'open'], url: e.spec.open, pagePrefix: true });
      }
    }
    (Array.isArray(entry.steps) ? entry.steps : []).forEach((raw: unknown, j) => {
      if (!obj(raw)) return;
      const sp: IssuePath = [...p, 'steps', j];
      const keys = stepActionKeys(raw);
      if (keys.includes('open')) {
        const v = raw.open;
        if (typeof v === 'string') out.push({ path: [...sp, 'open'], url: v, pagePrefix: false });
        else if (obj(v) && typeof v.url === 'string') out.push({ path: [...sp, 'open', 'url'], url: v.url, pagePrefix: false });
      }
      if (keys.includes('new_tab')) {
        const v = raw.new_tab;
        if (typeof v === 'string' && typeof (normalizeStep({ new_tab: v } as never, 0).args as { href?: unknown }).href === 'string') {
          out.push({ path: [...sp, 'new_tab'], url: v, pagePrefix: false });
        } else if (obj(v) && typeof v.href === 'string') out.push({ path: [...sp, 'new_tab', 'href'], url: v.href, pagePrefix: false });
      }
    });
  });
  return out;
}

/** A `<page>:` prefix as a multi-page scene writes it (core splitPageOpen). */
const PAGE_PREFIX = /^([A-Za-z_][A-Za-z0-9_-]*):/;

/** Schemes that never name a page of an environment: refused in `pages[].open` even when no environment is known. */
const NEVER_A_PAGE = /^(?:file|data|javascript|blob|view-source|chrome|chrome-extension|devtools|filesystem)$/i;

/**
 * navigationProblem for every URL of a scenario (scenarioNavigationRefs), with where it is: templated text (`{{…}}`) is
 * left to the run, `<page>:/path` of a page of `o.pageKeys` is a path. Without `o.pageKeys` (no environment known), a
 * `<page>:` prefix that is not http, https or about is left to the run too — it may name a page —, unless it is a scheme
 * that never does (`file:`, `data:`, `javascript:`, `blob:`, `view-source:`, `chrome:`…). With `o.pageKeys`, a prefix
 * that names no page is refused, whatever it would open.
 */
export function scenarioNavigationProblems(sc: unknown, o: NavigationOptions & { pageKeys?: readonly string[] } = {}): Array<{ path: IssuePath; message: string }> {
  const out: Array<{ path: IssuePath; message: string }> = [];
  for (const ref of scenarioNavigationRefs(sc)) {
    if (ref.url.includes('{{')) continue;
    let hint = '';
    let notAPage: string | null = null;
    if (ref.pagePrefix) {
      const prefix = PAGE_PREFIX.exec(ref.url)?.[1];
      if (prefix !== undefined && !/^(?:https?|about)$/i.test(prefix)) {
        if (!o.pageKeys) {
          if (!NEVER_A_PAGE.test(prefix)) continue;
        } else {
          if (splitPageOpen(ref.url, o.pageKeys)) continue;
          const pages = `${o.envName !== undefined ? `environment "${o.envName}"` : 'the environment'}${suggestion(prefix, o.pageKeys)} (available: ${o.pageKeys.join(', ') || 'none'})`;
          hint = `; "${prefix}:" is not a page of ${o.envName !== undefined ? `environment "${o.envName}"` : 'the environment'} either${suggestion(prefix, o.pageKeys)} (available: ${o.pageKeys.join(', ') || 'none'})`;
          notAPage = `${shownUrl(ref.url)}: "${prefix}:" is not a page of ${pages} — write \`<page>:/path\` with a page of the environment`;
        }
      }
    }
    const message = navigationProblem(ref.url, o);
    if (message) out.push({ path: ref.path, message: message + hint });
    else if (notAPage) out.push({ path: ref.path, message: notAPage });
  }
  return out;
}
