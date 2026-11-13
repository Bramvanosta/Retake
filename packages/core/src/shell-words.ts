/**
 * The one shell lexer of Retake: quotes (single, double, ANSI-C `$'…'`, `$"…"`), backslashes, `#` comments, control
 * operators, expansions and substitutions read as bash reads them. Its users choose how `$` reads (`LexOptions.dollar`):
 * the destructive-hook guard, the file words of an approval and the trust scan of a hook's files keep expansions as
 * written and mark the word computed; the host scan expands variables from what the script set.
 */

/** Shell control operators that separate commands. */
export const SHELL_OPERATORS: ReadonlySet<string> = new Set([';', '&', '|', '&&', '||', ';;', '(', ')', '\n']);

/** Stands for a part of a word computed when the command runs (a lookup's unknown value, a substitution). */
export const DYN = '\uE000';

/** A token of a command: a word (quoting resolved), a control operator, or a redirect operator. */
export interface ShellToken {
  text: string;
  op?: true;
  /** A redirect operator (`>`, `2>>`, `<<<`…), with `LexOptions.redirects` only. */
  redirect?: true;
  /** A `NAME=value` (or `NAME+=value`) word written as such (unquoted name). */
  assign?: true;
  /** Variables expanded into this word (a lookup's known values). */
  vars?: string[];
  /** Part of the word is computed when the command runs: an expansion, a command or process substitution. */
  computed?: true;
  /** Unquoted pattern characters: a glob (`*`, `?`, `[`) or a brace expansion (`{a,b}`, `{1..3}`) the shell expands. */
  pattern?: true;
}

export interface LexOptions {
  /**
   * How `$` and backticks read (ANSI-C and `$"…"` quoting are always resolved). `'keep'`: every expansion and
   * substitution kept as written, its word marked `computed`. A function:
   * `$NAME` / `${NAME…}` expanded like sh does with its values (field splitting outside double quotes, DYN for an
   * unknown value), substitutions become DYN.
   */
  dollar: 'keep' | ((name: string) => string | undefined);
  /** The script of each command and process substitution met (the caller scans it as a script). */
  sub?: (script: string) => void;
  /** Redirect operators are tokens of their own, even glued to a word (a file descriptor's digits before them dropped). */
  redirects?: boolean;
}

/** Index after the `)` matching the `(` at `open` (quotes and nesting followed roughly). */
export function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      i = e < 0 ? s.length : e;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return s.length;
}

/** Index of the backtick closing the one at `open` (or the end). */
function closeBacktick(s: string, open: number): number {
  let j = open + 1;
  while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
  return Math.min(j, s.length);
}

/** The command inside backticks, with the shell's backslash escapes removed. */
function backtickScript(s: string, open: number, close: number): string {
  return s.slice(open + 1, close).replace(/\\([\\`$])/g, '$1');
}

/**
 * The command substitutions (`$(…)`, backticks) of text the shell expands without splitting it into words (an
 * unquoted heredoc body, the word of `${X:-word}`): each one goes to `sub`.
 */
export function substitutions(text: string, sub: ((script: string) => void) | undefined): void {
  if (!sub) return;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '$' && text[i + 1] === '(') {
      const end = closeParen(text, i + 1);
      if (text[i + 2] !== '(') sub(text.slice(i + 2, end - 1)); // $((…)) is arithmetic
      i = end - 1;
    } else if (ch === '`') {
      const end = closeBacktick(text, i);
      sub(backtickScript(text, i, end));
      i = end;
    }
  }
}

const ANSI_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** `$'…'` (ANSI-C quoting) starting at cmd[i] (`$`): [value, index of the closing quote]. */
function ansiC(cmd: string, i: number): [string, number] {
  let out = '';
  let j = i + 2;
  while (j < cmd.length && cmd[j] !== "'") {
    if (cmd[j] !== '\\' || j + 1 >= cmd.length) {
      out += cmd[j++];
      continue;
    }
    const e = cmd[j + 1];
    const m = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/.exec(cmd.slice(j + 1, j + 10));
    if (ANSI_ESCAPES[e] !== undefined) {
      out += ANSI_ESCAPES[e];
      j += 2;
    } else if (m) {
      const code = parseInt(m[1] ?? m[2] ?? m[3] ?? m[4], m[4] !== undefined ? 8 : 16);
      out += code <= 0x10ffff ? String.fromCodePoint(code) : '';
      j += 1 + m[0].length;
    } else {
      out += `\\${e}`;
      j += 2;
    }
  }
  return [out, j];
}

const REDIRECT_OP = /^(?:&>>|&>|>>|>\||>&|<<<|<<|<>|<|>)/;

/**
 * The tokens of ONE command of `cmd` from `from`, and the control operator ending it (see LexOptions for `$`). One
 * command at a time, so a caller expanding variables sees an assignment in the commands after it.
 */
export function lexCommand(cmd: string, from: number, o: LexOptions): { toks: ShellToken[]; next: number } {
  const out: ShellToken[] = [];
  const keep = o.dollar === 'keep';
  const lookup = typeof o.dollar === 'function' ? o.dollar : undefined;
  const sub = o.sub;
  let cur = '';
  let inWord = false;
  let quoted = false;
  let assign = false;
  let computed = false;
  /** Whether every character of `cur` so far is an unquoted digit (a file descriptor before a redirect). */
  let digits = true;
  let used: string[] = [];
  /** The unquoted characters of the word written as such (not those an expansion gave). */
  let bare = '';
  const flush = () => {
    const pattern = /[*?[]/.test(bare) || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(bare);
    if (inWord)
      out.push({
        text: cur,
        ...(assign ? { assign: true as const } : {}),
        ...(used.length ? { vars: used } : {}),
        ...(computed ? { computed: true as const } : {}),
        ...(pattern ? { pattern: true as const } : {}),
      });
    bare = '';
    cur = '';
    inWord = false;
    quoted = false;
    assign = false;
    computed = false;
    digits = true;
    used = [];
  };
  const add = (text: string, isQuoted: boolean) => {
    cur += text;
    inWord = true;
    if (isQuoted) quoted = true;
    if (isQuoted || !/^[0-9]*$/.test(text)) digits = false;
  };
  const value = (name: string): string | undefined => {
    const v = lookup?.(name);
    if (v !== DYN) used.push(`$${name}`);
    return v;
  };
  /** The expansion at cmd[i] (`$`): [value, index after it, computed]; null when `$` is literal. */
  const expansion = (i: number): [string, number, boolean] | null => {
    const next = cmd[i + 1];
    const kept = (end: number): [string, number, boolean] => [cmd.slice(i, end), end, true];
    if (next === '(') {
      const end = closeParen(cmd, i + 1);
      if (cmd[i + 2] !== '(') sub?.(cmd.slice(i + 2, end - 1)); // $((…)) is arithmetic
      return keep ? kept(end) : [DYN, end, true];
    }
    if (next === '{') {
      const end = cmd.indexOf('}', i + 2);
      if (end < 0) return keep ? kept(cmd.length) : [DYN, cmd.length, true];
      const body = cmd.slice(i + 2, end);
      const m = /^([A-Za-z_]\w*)(?:(:?[-=?+])([\s\S]*))?$/.exec(body);
      if (!m || keep) {
        substitutions(m?.[2] ? m[3] : body, sub);
        return keep ? kept(end + 1) : [DYN, end + 1, true];
      }
      const v = value(m[1]);
      if (!m[2]) return [v ?? '', end + 1, (v ?? '').includes(DYN)];
      substitutions(m[3], sub);
      if (v?.includes(DYN)) return [DYN, end + 1, true];
      const set = m[2].startsWith(':') ? (v ?? '') !== '' : v !== undefined;
      const word = /[$`]/.test(m[3]) ? DYN : m[3];
      const r = m[2].endsWith('+') ? (set ? word : '') : set ? v! : m[2].endsWith('?') ? '' : word;
      return [r, end + 1, r.includes(DYN)];
    }
    const name = /^[A-Za-z_]\w*/.exec(cmd.slice(i + 1, i + 257));
    if (name) {
      if (keep) return kept(i + 1 + name[0].length);
      const v = value(name[0]) ?? '';
      return [v, i + 1 + name[0].length, v.includes(DYN)];
    }
    if (next === '"') return ['', i + 1, false]; // $"…": a translatable string, read as "…"
    if (next !== undefined && /[1-9@*]/.test(next)) return keep ? kept(i + 2) : [DYN, i + 2, true]; // positional parameters (function arguments)
    if (next !== undefined && /[0#?$!-]/.test(next)) return keep ? kept(i + 2) : ['', i + 2, false];
    return null;
  };
  const addUnquoted = (v: string) => {
    const from = used;
    v.split(/[ \t\n]+/).forEach((part, k) => {
      if (k > 0) {
        flush();
        used = [...from]; // the words a split expansion makes came from it too
      }
      if (part) add(part, false);
    });
  };
  /** A command or process substitution's text: kept as written, or DYN. */
  const substituted = (script: string, written: string) => {
    sub?.(script);
    add(keep ? written : DYN, false);
    computed = true;
  };
  let x: [string, number, boolean] | null;
  for (let i = from; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end < 0 ? cmd.length : end;
      add(cmd.slice(i + 1, stop), true);
      i = stop;
    } else if (c === '$' && cmd[i + 1] === "'") {
      const [v, end] = ansiC(cmd, i);
      add(v, true);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length && '"\\$`\n'.includes(cmd[j + 1])) {
          if (cmd[j + 1] !== '\n') text += cmd[j + 1];
          j += 2;
        } else if (cmd[j] === '$' && (x = expansion(j))) {
          text += x[0];
          if (x[2]) computed = true;
          j = x[1];
        } else if (cmd[j] === '`') {
          const e = closeBacktick(cmd, j);
          sub?.(backtickScript(cmd, j, e));
          text += keep ? cmd.slice(j, e + 1) : DYN;
          computed = true;
          j = e + 1;
        } else text += cmd[j++];
      }
      add(text, true);
      i = j;
    } else if (c === '\\') {
      if (i + 1 < cmd.length && cmd[i + 1] !== '\n') add(cmd[i + 1], true);
      i++;
    } else if (c === '$' && (x = expansion(i))) {
      if (x[2]) computed = true;
      if (x[0] === DYN || keep) add(x[0], false);
      else addUnquoted(x[0]);
      i = x[1] - 1;
    } else if (c === '`') {
      const e = closeBacktick(cmd, i);
      substituted(backtickScript(cmd, i, e), cmd.slice(i, e + 1));
      i = e;
    } else if (!o.redirects && (c === '<' || c === '>') && cmd[i + 1] === '(') {
      flush(); // `<` and `>` end a word: a process substitution starts one
      const end = closeParen(cmd, i + 1);
      substituted(cmd.slice(i + 2, end - 1), cmd.slice(i, end));
      i = end - 1;
    } else if (c === '#' && !inWord) {
      const end = cmd.indexOf('\n', i);
      i = (end < 0 ? cmd.length : end) - 1;
    } else if (c === ' ' || c === '\t') {
      flush();
    } else if (o.redirects && (c === '<' || c === '>' || (c === '&' && cmd[i + 1] === '>'))) {
      // A redirect: the digits of a file descriptor before it are part of it, any other word before it ends.
      if (inWord && digits) {
        cur = '';
        inWord = false;
      }
      flush();
      const op = REDIRECT_OP.exec(cmd.slice(i))?.[0] ?? c;
      out.push({ text: op, redirect: true });
      i += op.length - 1;
    } else if (!o.redirects && c === '&' && /[<>]$/.test(cur)) {
      add(c, false); // 2>&1
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      flush();
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === ';;') {
        out.push({ text: two, op: true });
        return { toks: out, next: i + 2 };
      }
      out.push({ text: c, op: true });
      return { toks: out, next: i + 1 };
    } else {
      if (c === '=' && !assign && !quoted && /^[A-Za-z_]\w*\+?$/.test(cur)) assign = true;
      add(c, false);
      bare += c;
    }
  }
  flush();
  return { toks: out, next: cmd.length };
}

/** Every token of a script, command after command (see lexCommand). */
export function lexShell(cmd: string, o: LexOptions): ShellToken[] {
  const out: ShellToken[] = [];
  for (let at = 0; at < cmd.length; ) {
    const { toks, next } = lexCommand(cmd, at, o);
    out.push(...toks);
    at = next;
  }
  return out;
}

/**
 * The tokens of a command as `shellWords` reads it: expansions and substitutions kept as written and marked
 * `computed`, the script of each command or process substitution given to `sub`.
 */
export function shellTokens(cmd: string, sub?: (script: string) => void): ShellToken[] {
  return lexShell(cmd, { dollar: 'keep', ...(sub ? { sub } : {}) });
}

/**
 * Split a shell command into words and control operators (quotes and backslashes resolved, `#` comments dropped,
 * expansions and substitutions kept as written, the script of each substitution given to `sub`). Good enough to find commands and their arguments; not a full shell
 * parser (no heredocs).
 */
export function shellWords(cmd: string, sub?: (script: string) => void): string[] {
  return shellTokens(cmd, sub).map((t) => t.text);
}

export interface ShellCommand<T = string> {
  args: T[];
  /** Operator that precedes this command (`|` for the right side of a pipe). */
  after?: string;
}

/** Group the words of `shellWords` (or the tokens of `shellTokens`) into commands, split at control operators. */
export function shellCommands<T extends string | ShellToken>(words: readonly T[]): ShellCommand<T>[] {
  const out: ShellCommand<T>[] = [];
  let args: T[] = [];
  let prevOp: string | undefined;
  for (const w of words) {
    const op = typeof w === 'string' ? (SHELL_OPERATORS.has(w) ? w : undefined) : w.op ? w.text : undefined;
    if (op !== undefined) {
      if (args.length) out.push({ args, after: prevOp });
      args = [];
      prevOp = op;
    } else args.push(w);
  }
  if (args.length) out.push({ args, after: prevOp });
  return out;
}

/** Words skipped before the command name: shell keywords and grouping. */
export const PREFIX_WORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'coproc', 'function']);
/** Wrappers that run the rest of the line as a command, with the options that take a value. */
export const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-C', '-D', '-p', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
  exec: new Set(['-a']),
  nice: new Set(['-n']),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  setsid: new Set(),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  gtimeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--process-slot-var']),
  watch: new Set(['-n', '--interval']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
/** A redirection with its target in the next word (`>`, `2>>`, `<`, `<<<`), or attached to it (`>out.txt`, `2>&1`). */
export const REDIRECT_ALONE = /^(\d*|&)(>>?|>\||<<?<?|<>|>&|<&)$/;
export const REDIRECT_ATTACHED = /^(\d*|&)(>>?|>\||<<?-?|<>|>&|<&)./;

/**
 * The index of the word a command runs (assignments, redirections, keywords — `function NAME`, `coproc`, `time -p` —
 * and wrappers such as `sudo`, `env`, `timeout` skipped), or -1 when it runs none. `onAssign` sees each assignment
 * skipped on the way (`NAME=value` words, and those after `env`).
 */
export function commandWordAt(args: readonly ShellToken[], onAssign?: (text: string) => void): number {
  let i = 0;
  const text = (k: number) => (args[k] as ShellToken | undefined)?.text;
  while (i < args.length) {
    const t = args[i] as ShellToken;
    const procSub = t.computed === true && /^[<>]\(/.test(t.text); // `<(…)` is a word, not a redirect
    if (t.assign) {
      onAssign?.(t.text);
      i++;
      continue;
    }
    if (!procSub && REDIRECT_ATTACHED.test(t.text)) {
      i++;
      continue;
    }
    if (REDIRECT_ALONE.test(t.text)) {
      i += 2;
      continue;
    }
    const name = commandName(t.text);
    if (name === 'function') {
      i += 2; // its name
      continue;
    }
    if (name === 'coproc') {
      i += text(i + 2) === '{' ? 2 : 1; // `coproc NAME { …; }`
      continue;
    }
    if (name === 'time') {
      i++;
      while (text(i) === '-p' || text(i) === '--') i++;
      continue;
    }
    if (PREFIX_WORDS.has(name)) {
      i++;
      continue;
    }
    const wrapper = WRAPPERS[name];
    if (!wrapper) return i;
    i++;
    while (i < args.length && (text(i) as string).startsWith('-')) i += wrapper.has(text(i) as string) ? 2 : 1;
    if (name === 'env') {
      while (i < args.length && /^[A-Za-z_]\w*=/.test(text(i) as string)) {
        onAssign?.(text(i) as string);
        i++;
      }
    }
    if (name === 'timeout' || name === 'gtimeout') i++; // the duration
  }
  return -1;
}

/** "/usr/bin/psql" → "psql" */
export function commandName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** The shells whose script is followed (`-c`, standard input). */
export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'yash', 'fish', 'tcsh', 'csh']);

/** How a shell gets its script (shellInvocation). */
export interface ShellCall {
  /** The `-c` script, and the index of its word. */
  script?: string;
  scriptAt?: number;
  /** It reads its script from its standard input (no operand, `-s`, `-`). */
  stdin?: true;
  /** The index of the script file it runs. */
  fileAt?: number;
}

/**
 * How the shell at `args[i]` gets its script, or undefined when `args[i]` is no shell (`anyName`: whatever its name):
 * the `-c` script (`-c` alone or in a cluster — `-ec`, `-lc` —, after other options, `-o name` and `--` skipped), its
 * standard input (no operand, `-s`, `-`), or a script file.
 */
export function shellInvocation(args: readonly string[], i: number, anyName = false): ShellCall | undefined {
  if (!anyName && !SHELLS.has(commandName(args[i] ?? ''))) return undefined;
  let c = false;
  let s = false;
  let j = i + 1;
  for (; j < args.length; j++) {
    const a = args[j] as string;
    if (a === '--' || a === '-') {
      if (a === '-') s = true;
      j++;
      break;
    }
    if (a === '--rcfile' || a === '--init-file') {
      j++;
      continue;
    }
    if (a.startsWith('--')) continue;
    if (!/^[-+][A-Za-z]+$/.test(a)) break;
    if (a[0] === '-' && a.includes('c')) c = true;
    if (a[0] === '-' && a.includes('s')) s = true;
    j += (a.slice(1).match(/[oO]/g) ?? []).length; // `-o name`, `-eo name`
  }
  if (c) return args[j] === undefined ? {} : { script: args[j], scriptAt: j };
  return s || args[j] === undefined ? { stdin: true } : { fileAt: j };
}

/** The script of a `sh -c "<script>"` invocation found at `args[i]`, if any (shellInvocation). */
export function nestedShellScript(args: readonly string[], i: number): string | undefined {
  return shellInvocation(args, i)?.script;
}

/** A here-document of a shell command (`<<EOF` … `EOF`, `<<-'EOF'`). */
export interface Heredoc {
  /** Index of the `<<` operator. */
  start: number;
  /** Index where the body starts (the line after the operator). */
  bodyStart: number;
  /** Index after the terminator line. */
  end: number;
  body: string;
  /** The delimiter is quoted: the shell does not expand the body. */
  quoted: boolean;
}

/** Here-documents of a command, in order (a fresh regex per call: no shared `lastIndex`). */
export function heredocs(cmd: string): Heredoc[] {
  const re = /(<<-?\s*(['"]?)([A-Za-z_][\w]*)\2[^\n]*\n)([\s\S]*?)\n[ \t]*\3[ \t]*(?:\n|$)/g;
  return [...cmd.matchAll(re)].map((m) => ({
    start: m.index,
    bodyStart: m.index + m[1].length,
    end: m.index + m[0].length,
    body: m[4],
    quoted: m[2] !== '',
  }));
}
