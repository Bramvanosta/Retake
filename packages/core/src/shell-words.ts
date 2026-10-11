/** Shell control operators that separate commands. */
export const SHELL_OPERATORS: ReadonlySet<string> = new Set([';', '&', '|', '&&', '||', ';;', '(', ')', '\n']);

/**
 * Split a shell command into words and control operators (quotes and backslashes resolved, `#` comments
 * dropped). Good enough to find commands and their arguments; not a full shell parser (no expansions,
 * no heredocs).
 */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  const flush = () => {
    if (inWord) out.push(cur);
    cur = '';
    inWord = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end < 0 ? cmd.length : end;
      cur += cmd.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length && '"\\$`\n'.includes(cmd[j + 1])) j++;
        cur += cmd[j];
        j++;
      }
      inWord = true;
      i = j;
    } else if (c === '\\') {
      if (i + 1 < cmd.length && cmd[i + 1] !== '\n') cur += cmd[i + 1];
      inWord = true;
      i++;
    } else if (c === '#' && !inWord) {
      const end = cmd.indexOf('\n', i);
      i = (end < 0 ? cmd.length : end) - 1;
    } else if (c === ' ' || c === '\t') {
      flush();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      flush();
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === ';;') {
        out.push(two);
        i++;
      } else out.push(c);
    } else {
      cur += c;
      inWord = true;
    }
  }
  flush();
  return out;
}

export interface ShellCommand {
  args: string[];
  /** Operator that precedes this command (`|` for the right side of a pipe). */
  after?: string;
}

/** Group the words of `shellWords` into commands, split at control operators. */
export function shellCommands(words: readonly string[]): ShellCommand[] {
  const out: ShellCommand[] = [];
  let args: string[] = [];
  let prevOp: string | undefined;
  for (const w of words) {
    if (SHELL_OPERATORS.has(w)) {
      if (args.length) out.push({ args, after: prevOp });
      args = [];
      prevOp = w;
    } else args.push(w);
  }
  if (args.length) out.push({ args, after: prevOp });
  return out;
}

/** "/usr/bin/psql" → "psql" */
export function commandName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/** The script of a `sh -c "<script>"` invocation found at `args[i]`, if any. */
export function nestedShellScript(args: readonly string[], i: number): string | undefined {
  return SHELLS.has(commandName(args[i] ?? '')) && args[i + 1] === '-c' ? args[i + 2] : undefined;
}
