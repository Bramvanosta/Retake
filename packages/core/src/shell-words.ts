/**
 * The words and commands of a shell script, read with the one shell lexer (shell-lex.ts): commands split at control
 * operators, the command word past keywords, assignments and wrappers, nested shell invocations, heredocs.
 */
import { SHELL_OPERATORS, lexShell } from './shell-lex.js';
import type { ShellToken } from './shell-lex.js';

export { DYN, SHELL_OPERATORS, closeParen, lexCommand, lexShell, substitutions } from './shell-lex.js';
export type { LexOptions, ShellToken } from './shell-lex.js';

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
