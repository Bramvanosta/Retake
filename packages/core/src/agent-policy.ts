/**
 * The shared rules for work an agent can shape (trust `mcp`, core HookTrust): one home for the lists every package
 * applies, so the engine, the hooks and the runner never keep their own copy.
 *
 * Loader variables: environment variables that make a program load code, change the shell it starts or the folders it
 * reads its configuration from, before the command itself runs — node (NODE_OPTIONS, NODE_PATH), the shell (PATH, HOME,
 * ZDOTDIR, XDG_CONFIG_HOME, BASH_ENV, ENV, SHELLOPTS, BASHOPTS, PS4, PROMPT_COMMAND, IFS, CDPATH), the dynamic linker
 * (DYLD_*, LD_*), git (GIT_*), the interpreters (PYTHON*, PERL5LIB, PERL5OPT, RUBYOPT, RUBYLIB, *JAVA*_OPTIONS) and the
 * package managers (npm_config_*, PNPM_*, YARN_*, COREPACK_*).
 *
 * Navigation: the URLs a scenario opens (navigationProblem, scenarioNavigationProblems) and the one origin comparison
 * (canonicalOrigin).
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentWritable, channelWords, realPathOf } from './agent-trust.js';
import type { AgentChannel } from './agent-trust.js';
import { showHiddenChars } from './brand.js';
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

/**
 * The simple commands of a shell text, each as its words (quotes and backslashes resolved, `$'…'` decoded): split on
 * `;`, `&`, `&&`, `|`, `||`, `(`, `)` and newlines, and at every command substitution — `$(…)` and backticks, inside
 * double quotes too. Redirection operators (`<`, `<<`, `>`, `>&`…) are words of their own; a `#` comment is skipped to the
 * end of its line, as the shell does. Conservative, not a parser: a heredoc body or a `case` pattern is read as
 * commands too, so a rule applied to every simple command sees at least what the shell runs.
 */
export function simpleCommands(text: string): string[][] {
  return shellCommandList(text).map((c) => c.words);
}

/** A simple command of a shell text (shellCommandList): its words, and the operator before it. */
export interface SimpleCommand {
  words: string[];
  /**
   * What precedes it: `|` (the right side of a pipe, `|&` included, also across a newline or a `(`), `||`, `&&`, `;`,
   * `&`, a newline, `(`, `)`, `$(` or a backtick; undefined for the first one.
   */
  after?: string;
}

/** simpleCommands, with the operator before each command (SimpleCommand.after). */
export function shellCommandList(text: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let words: string[] = [];
  let cur = '';
  let inWord = false;
  let pending: string | undefined;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  // `op`: the operator that ends it. An empty command keeps a pending pipe: `a |\n b`, `a | (b)` read from the pipe.
  const endCommand = (op?: string) => {
    endWord();
    if (words.length) {
      out.push(pending === undefined ? { words } : { words, after: pending });
      pending = op;
    } else if (pending !== '|') pending = op ?? pending;
    words = [];
  };
  // `dq`: inside double quotes; `sub`: a `$(…)` opened inside double quotes (depth: its own parentheses); `tick`: a
  // backtick substitution.
  const stack: Array<{ mode: 'top' | 'dq' | 'sub' | 'tick'; depth: number }> = [{ mode: 'top', depth: 0 }];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top.mode === 'dq') {
      if (c === '"') stack.pop();
      else if (c === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
        if (text[i + 1] !== '\n') cur += text[i + 1];
        i++;
      } else if (c === '`' || (c === '$' && text[i + 1] === '(')) {
        endCommand(c === '`' ? '`' : '$(');
        stack.push({ mode: c === '`' ? 'tick' : 'sub', depth: 0 });
        if (c === '$') i++;
        continue;
      } else cur += c;
      inWord = true;
      continue;
    }
    if (c === '#' && !inWord) {
      // A comment, to the end of its line (the shell skips it: a quote in it opens nothing).
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? text.length : end;
      cur += text.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '$' && text[i + 1] === "'") {
      const { value, end } = ansiCQuoted(text, i + 2);
      cur += value;
      inWord = true;
      i = end;
    } else if (c === '$' && text[i + 1] === '"') {
      stack.push({ mode: 'dq', depth: 0 });
      inWord = true;
      i++;
    } else if (c === '"') {
      stack.push({ mode: 'dq', depth: 0 });
      inWord = true;
    } else if (c === '\\') {
      if (i + 1 < text.length && text[i + 1] !== '\n') {
        cur += text[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === '`') {
      endCommand('`');
      if (top.mode === 'tick') stack.pop();
      else stack.push({ mode: 'tick', depth: 0 });
    } else if (c === '(') {
      endCommand(text[i - 1] === '$' ? '$(' : '(');
      if (top.mode === 'sub') top.depth++;
    } else if (c === ')') {
      endCommand(')');
      if (top.mode === 'sub') {
        if (top.depth > 0) top.depth--;
        else stack.pop();
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      const two = text.slice(i, i + 2);
      if (two === '||' || two === '&&' || two === '|&') i++;
      endCommand(two === '||' || two === '&&' ? two : c);
    } else if (c === '<' || c === '>') {
      endWord();
      let op = c;
      while (i + 1 < text.length && '<>&'.includes(text[i + 1])) op += text[++i];
      words.push(op);
    } else {
      cur += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

/** A `$'…'` string from `start` (after the quote): its decoded value and the index of its closing quote. */
function ansiCQuoted(text: string, start: number): { value: string; end: number } {
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  let value = '';
  let i = start;
  for (; i < text.length && text[i] !== "'"; i++) {
    if (text[i] !== '\\' || i + 1 >= text.length) {
      value += text[i];
      continue;
    }
    const n = text[++i];
    const hex = (max: number) => {
      const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(text.slice(i + 1));
      if (!m) return n;
      i += m[0].length;
      return String.fromCodePoint(parseInt(m[0], 16));
    };
    if (Object.hasOwn(simple, n)) value += simple[n];
    else if (n === 'x') value += hex(2);
    else if (n === 'u') value += hex(4);
    else if (n === 'U') value += hex(8);
    else if (/[0-7]/.test(n)) {
      const m = /^[0-7]{0,2}/.exec(text.slice(i + 1))![0];
      value += String.fromCharCode(parseInt(n + m, 8));
      i += m.length;
    } else if (n === 'c' && i + 1 < text.length) value += String.fromCharCode(text[++i].charCodeAt(0) & 31);
    else value += `\\${n}`;
  }
  return { value, end: i };
}

/** Builtins and keywords that set the variables they name: `for NAME in`, `read NAME`, `printf -v NAME`, `export NAME`… */
const VARIABLE_SETTERS = new Set(['for', 'select', 'read', 'getopts', 'mapfile', 'readarray', 'printf', 'declare', 'typeset', 'local', 'export', 'readonly', 'let']);

/** `NAME=`, `NAME+=`, `NAME[i]=`: an assignment word (or an `env` / `export` argument) and the variable it sets. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
const VARIABLE_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?$/;

/**
 * The loader variables a shell text sets, in order, once each: every `NAME=` / `NAME+=` / `NAME[i]=` word of any simple
 * command (an assignment before the command, an `env` or `export` argument), and the names a simple command that holds
 * a variable setter (`for`, `select`, `read`, `getopts`, `mapfile`, `readarray`, `printf -v`, `declare`, `typeset`,
 * `local`, `export`, `readonly`, `let`) lists.
 */
export function loaderAssignments(text: string): string[] {
  const found = new Set<string>();
  for (const words of simpleCommands(text)) {
    const setter = words.some((w) => VARIABLE_SETTERS.has(w));
    for (const w of words) {
      const name = ASSIGNMENT.exec(w)?.[1] ?? (setter ? VARIABLE_WORD.exec(w)?.[1] : undefined);
      if (name !== undefined && isLoaderEnvName(name)) found.add(name);
    }
  }
  return [...found];
}

/**
 * The loader variables an agent-written shell command would set (trust `mcp`): the names of its `env` that are loader
 * variables, then the ones its text assigns (loaderAssignments) — each once, in that order. Empty: none.
 */
export function agentShellLoaderVariables(run: string, env?: Readonly<Record<string, string>>): string[] {
  const found = new Set<string>();
  for (const name of Object.keys(env ?? {})) if (isLoaderEnvName(name)) found.add(name);
  for (const name of loaderAssignments(run)) found.add(name);
  return [...found];
}

/** Where agentShellProblems judges the paths of a command. */
export interface AgentShellOptions {
  /** The project folder: a path through one of its agent-writable folders (core AGENT_WRITABLE_PATHS) is refused. */
  projectDir: string;
  /** The folder the command runs in, which relative words resolve from (default projectDir). */
  cwd?: string;
  /** What `~` stands for (default the home folder). */
  home?: string;
}

/**
 * Where a path an agent-written shell command names leads, when that is through a folder an agent can write (core
 * agentWritable): of the project (`runs/…`, `scenarios/…`, README.md…), or of a project beside it — the agent writes the
 * scenarios of every project of the workspace. Its project-relative form (`runs/x/a.sh`, `../other/runs/a.sh`), else
 * null. Symbolic links of its existing part are followed; it need not exist. `~` and `~/…` stand for `o.home`, a
 * `file://` URL for its path; `tilde: false` takes `~` literally (a hook's cwd).
 */
export function agentWritablePath(path: string, o: AgentShellOptions & { tilde?: boolean }): string | null {
  let p = path.replace(/^file:\/\//i, '');
  if (o.tilde !== false && (p === '~' || p.startsWith('~/'))) p = join(o.home ?? homedir(), p.slice(1));
  const real = realPathOf(resolve(o.cwd ?? o.projectDir, p));
  const below = (base: string): string | undefined => {
    const rel = relative(base, real);
    return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
  };
  const root = realPathOf(resolve(o.projectDir));
  const own = below(root);
  if (own !== undefined) return agentWritable(own) ? own.split(sep).join('/') : null;
  const beside = below(realPathOf(dirname(root)));
  if (beside === undefined) return null;
  const [, ...rest] = beside.split(sep);
  return rest.length && agentWritable(rest.join(sep)) ? `../${beside.split(sep).join('/')}` : null;
}

/** The folder of agentWritablePath's answer, for a message: "runs/", "README.md", "runs/ of another project". */
function writableFolder(rel: string): string {
  const parts = rel.split('/');
  if (parts[0] === '..') return `${parts[3] === undefined ? parts[2] : `${parts[2]}/`} of another project`;
  return parts.length > 1 ? `${parts[0]}/` : parts[0];
}

/** Shell keywords that may come before a command word (`if cd x; then`, `! eval …`, `time exec …`). */
const SHELL_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', '!', '{', '}', '[[', ']]', 'time', 'select', 'function', 'coproc']);

/** Builtins refused as a command word: they change the folder paths resolve from, or run text as a command. */
const REFUSED_BUILTINS: Record<string, string> = {
  cd: "changes the folder its paths resolve from: set the hook's `cwd` instead",
  pushd: "changes the folder its paths resolve from: set the hook's `cwd` instead",
  popd: "changes the folder its paths resolve from: set the hook's `cwd` instead",
  eval: 'runs text as a command',
  exec: 'replaces the shell with another command',
  command: 'runs a command it is given by name',
  builtin: 'runs a shell builtin it is given by name',
};

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

/** A script file an interpreter reads its program from (its input, from a pipe, is then data). */
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|rb|pl|php|lua|r|awk|applescript|scpt|ps1)$/i;

/** Package runners that run a package, downloading it when it is not installed: `npx`, `pnpm dlx`, `npm exec`… */
const PACKAGE_RUNNERS: Record<string, readonly string[] | true> = {
  npx: true,
  pnpx: true,
  bunx: true,
  npm: ['exec', 'x', 'create'],
  pnpm: ['dlx', 'create'],
  yarn: ['dlx', 'create'],
  bun: ['x', 'create'],
};

/** git's global options that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** The words of a command word that may name a path: the word, the value after `=`, after `-X`, after `@`, each `:` part. */
function pathCandidates(w: string): string[] {
  const out = new Set<string>([w]);
  const eq = w.indexOf('=');
  if (eq >= 0) out.add(w.slice(eq + 1));
  if (/^-[^-]./.test(w)) out.add(w.slice(2));
  if (w.startsWith('@')) out.add(w.slice(1));
  for (const c of [...out]) if (c.includes(':') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(c)) for (const part of c.split(':')) out.add(part);
  return [...out].filter((c) => c !== '' && !/^[<>&|]+$/.test(c));
}

/** How a word is shown in a problem: hidden characters written out, a long one cut (the hook itself is shown in full). */
function shownWord(w: string): string {
  const v = showHiddenChars(w).replace(/\n/g, '\\u{a}');
  return v.length > 80 ? `${v.slice(0, 77)}…` : v;
}

/**
 * The constructs of a shell text the quoting decides (raw text): `$` and backticks outside single quotes (any
 * expansion: `$NAME`, `${…}`, `$(…)`, `$((…))`, `$'…'`), unquoted globs (`*`, `?`, `[…]`) and brace expansion
 * (`{a,b}`), `~name`, and input redirection (`<`, `<<`, `<<<`, `<(…)`). `nested`: a quoted string of another command,
 * which may run as a script later — only its `$` and backticks.
 */
function quotingProblems(text: string, nested: boolean): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  const BREAK = /[\s;&|()<>]/;
  let dq = false;
  let wordStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const startsWord = wordStart;
    wordStart = false;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '$') {
      add('`$` outside single quotes (an expansion: `$NAME`, `${…}`, `$(…)`, `$((…))`) — write the value itself, in single quotes');
      continue;
    }
    if (c === '`') {
      add('a backtick (a command substitution)');
      continue;
    }
    if (dq) {
      if (c === '"') dq = false;
      continue;
    }
    if (c === '"') {
      dq = true;
      continue;
    }
    if (c === '#' && startsWord) {
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (BREAK.test(c)) {
      wordStart = true;
      if (c === '<' && !nested) add('input redirection (`<`, `<<`, `<<<`, `<(…)`) — pass the file as an argument');
      continue;
    }
    if (nested) continue;
    if (c === '*' || c === '?') add('an unquoted glob (`*`, `?`, `[…]`) — quote it');
    else if (c === '[' || c === '{') {
      const close = c === '[' ? ']' : '}';
      let j = i + 1;
      while (j < text.length && !BREAK.test(text[j]) && text[j] !== close) j++;
      if (text[j] === close && (c === '[' || /,|\.\./.test(text.slice(i + 1, j)))) {
        add(c === '[' ? 'an unquoted glob (`*`, `?`, `[…]`) — quote it' : 'unquoted braces (a brace expansion: `{a,b}`, `{1..3}`) — quote them');
      }
    } else if (c === '~' && startsWords(startsWord, text, i)) {
      const next = text[i + 1];
      if (next !== undefined && next !== '/' && !BREAK.test(next)) add('`~name` (a folder the shell looks up) — write the path');
    }
  }
  return out;
}

/** Whether a `~` at `i` starts a word (or an assignment's value: `X=~x`, or a `:` list entry). */
function startsWords(startsWord: boolean, text: string, i: number): boolean {
  return startsWord || text[i - 1] === '=' || text[i - 1] === ':';
}

/** The problems of one simple command (agentShellProblems). */
function commandProblems(cmd: SimpleCommand, o: AgentShellOptions, nested: boolean, add: (p: string) => void): void {
  const { words } = cmd;
  let at = 0;
  while (at < words.length && (ASSIGNMENT.test(words[at]) || SHELL_KEYWORDS.has(words[at]))) at++;
  const name = words[at];
  if (name !== undefined && Object.hasOwn(REFUSED_BUILTINS, name)) add(`\`${name}\` (it ${REFUSED_BUILTINS[name]})`);

  let interpreter: { at: number; spec: Interpreter } | undefined;
  words.forEach((w, i) => {
    const base = word0(w);
    const rest = words.slice(i + 1);
    const spec = interpreterOf(w);
    if (spec) {
      interpreter ??= { at: i, spec };
      const flag = spec.code ? rest.find((r) => spec.code!.test(r)) : undefined;
      if (flag !== undefined) add(`\`${base} ${flag.replace(/=.*$/, '')}\` (it runs code written in the command) — put the code in a script under hooks/`);
      if (!spec.code && !rest.some((r) => /^(?:-f|--file)/.test(r))) add(`\`${base}\` with a program text (it can run commands) — put the program in a file under hooks/ and pass it with \`-f\``);
      if (spec.code && /^(?:python|pypy)/.test(base)) {
        const m = rest.indexOf('-m');
        if (m >= 0 && rest[m + 1] !== undefined) pathProblem(rest[m + 1].split('.').join('/'), o, add, rest[m + 1]);
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
      const sub = rest.find((r) => !r.startsWith('-'));
      if (sub !== undefined && runner.includes(sub)) add(`\`${base} ${sub}\` (it runs a package, downloading it when it is not installed)`);
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

  // An interpreter on the right side of a pipe reads its program from it, unless it is given a script file.
  if (cmd.after === '|' && interpreter) {
    const rest = words.slice(interpreter.at + 1);
    const fromStdin = rest.some((r) => r === '-' || r === '/dev/stdin' || (/^-[A-Za-z]*s[A-Za-z]*$/.test(r) && interpreter!.spec === INTERPRETERS[0]));
    if (fromStdin || !rest.some((r) => !r.startsWith('-') && SCRIPT_FILE.test(r))) {
      add(`\`| ${word0(words[interpreter.at])}\` (an interpreter reading its program from a pipe) — give it a script file`);
    }
  }

  words.forEach((w, i) => {
    if (i === at && !w.includes('/')) return; // a command looked up on PATH
    if (/^\/dev\/(?:stdin|fd\/)|^\/proc\/[^/]+\/fd\//.test(w)) add(`\`${shownWord(w)}\` (a stream read as a file)`);
    if (nested && !w.includes('/')) return;
    for (const c of pathCandidates(w)) pathProblem(c, o, add, w);
  });
}

function pathProblem(candidate: string, o: AgentShellOptions, add: (p: string) => void, word: string): void {
  const rel = agentWritablePath(candidate, o);
  if (rel !== null) add(`\`${shownWord(word)}\` (a path through ${writableFolder(rel)}, which an agent can write)`);
}

/**
 * What an agent-written shell command may not use (trust `mcp`, a hook the agent wrote): each problem once, in the
 * order found; empty when none. Read per simple command (shellCommandList), on the rendered text:
 * - `$` and backticks outside single quotes, unquoted globs and brace expansions, `~name`, input redirection
 *   (`<`, `<<`, `<<<`, `<(…)`);
 * - `cd`, `pushd`, `popd`, `eval`, `exec`, `command`, `builtin` as the command; `xargs`, `parallel`, `find -exec`,
 *   `env -S`; a shell's `-c`, inline code (`node -e` / `-p` / `--eval` / `-r` / `--require` / `--import`, `deno eval`,
 *   `python -c`, `perl -e`, `ruby -e`, `php -r`, `osascript -e`…), `awk` with a program text; an interpreter on the
 *   right side of a pipe without a script file (`| sh`, `| node`, `| python -`); `npx`, `pnpm dlx`, `npm exec`,
 *   `yarn dlx`, `bunx`…; `git -c`;
 * - a loader variable it sets (loaderAssignments);
 * - any word, or the value of `--opt=…`, `-Xvalue`, `@file` or a `:` list, that leads through a folder an agent can
 *   write (agentWritablePath; relative words from `o.cwd`), whether the file exists or not — `python -m`'s module too;
 *   and `/dev/stdin`, `/dev/fd/…`.
 * A word with spaces (a quoted string given to another command: `trap '…'`, `su -c '…'`, `ssh h '…'`) is read as a
 * script too: its `$` and backticks, its commands, and its words holding a `/`.
 * A deny-list, conservative where it reads: it refuses some harmless commands rather than miss one.
 */
export function agentShellProblems(text: string, o: AgentShellOptions): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  const visit = (t: string, depth: number) => {
    const nested = depth > 0;
    for (const p of quotingProblems(t, nested)) add(p);
    for (const name of loaderAssignments(t)) add(`\`${name}=\` (it sets ${name}, a loader variable)`);
    for (const cmd of shellCommandList(t)) {
      commandProblems(cmd, o, nested, add);
      if (depth < 3) for (const w of cmd.words) if (/\s/.test(w)) visit(w, depth + 1);
    }
  };
  visit(text, 0);
  return out;
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
      return null;
    }
    if (r.host === new URL(PROBE_BASE).host) return null;
    if (r.username || r.password) return credentialsProblem(shownUrl(url, r));
    if (!o.origins) return null;
    return `${shownUrl(url, r)} names a host without a scheme (\`//host/…\`): write the full http(s) URL of an environment page, or a path that starts with a single \`/\``;
  }
  const shown = shownUrl(url, u);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    if (u.protocol === 'about:' && u.href === 'about:blank') return null;
    const what = u.protocol === 'about:' ? `${u.href.slice(0, 40)}` : `a ${u.protocol} URL`;
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

/**
 * navigationProblem for every URL of a scenario (scenarioNavigationRefs), with where it is: templated text (`{{…}}`) is
 * left to the run, `<page>:/path` of a page of `o.pageKeys` is a path. Without `o.pageKeys` (no environment known), a
 * `<page>:` prefix that is not http, https or about is left to the run too — it may name a page.
 */
export function scenarioNavigationProblems(sc: unknown, o: NavigationOptions & { pageKeys?: readonly string[] } = {}): Array<{ path: IssuePath; message: string }> {
  const out: Array<{ path: IssuePath; message: string }> = [];
  for (const ref of scenarioNavigationRefs(sc)) {
    if (ref.url.includes('{{')) continue;
    let hint = '';
    if (ref.pagePrefix) {
      const prefix = PAGE_PREFIX.exec(ref.url)?.[1];
      if (prefix !== undefined && !/^(?:https?|about)$/i.test(prefix)) {
        if (!o.pageKeys) continue;
        if (splitPageOpen(ref.url, o.pageKeys)) continue;
        hint = `; "${prefix}:" is not a page of ${o.envName !== undefined ? `environment "${o.envName}"` : 'the environment'} either${suggestion(prefix, o.pageKeys)} (available: ${o.pageKeys.join(', ') || 'none'})`;
      }
    }
    const message = navigationProblem(ref.url, o);
    if (message) out.push({ path: ref.path, message: message + hint });
  }
  return out;
}
