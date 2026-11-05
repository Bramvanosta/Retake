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

/**
 * The simple commands of a shell text, each as its words (quotes and backslashes resolved, `$'…'` decoded): split on
 * `;`, `&`, `&&`, `|`, `||`, `(`, `)` and newlines, and at every command substitution — `$(…)` and backticks, inside
 * double quotes too. Redirection operators (`<`, `<<`, `>`, `>&`…) are words of their own. Conservative, not a parser:
 * a comment, a heredoc body or a `case` pattern is read as commands too, so a rule applied to every simple command
 * sees at least what the shell runs.
 */
export function simpleCommands(text: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
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
        endCommand();
        stack.push({ mode: c === '`' ? 'tick' : 'sub', depth: 0 });
        if (c === '$') i++;
        continue;
      } else cur += c;
      inWord = true;
      continue;
    }
    if (c === "'") {
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
      endCommand();
      if (top.mode === 'tick') stack.pop();
      else stack.push({ mode: 'tick', depth: 0 });
    } else if (c === '(') {
      endCommand();
      if (top.mode === 'sub') top.depth++;
    } else if (c === ')') {
      endCommand();
      if (top.mode === 'sub') {
        if (top.depth > 0) top.depth--;
        else stack.pop();
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      endCommand();
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
