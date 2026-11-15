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

/** The word being read: its text, how it was written, and the token it becomes when it ends. */
class WordBuilder {
  cur = '';
  inWord = false;
  quoted = false;
  assign = false;
  computed = false;
  /** Whether every character of `cur` so far is an unquoted digit (a file descriptor before a redirect). */
  digits = true;
  used: string[] = [];
  /** The unquoted characters of the word written as such (not those an expansion gave). */
  bare = '';

  constructor(private readonly out: ShellToken[]) {}

  flush(): void {
    const pattern = /[*?[]/.test(this.bare) || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(this.bare);
    if (this.inWord)
      this.out.push({
        text: this.cur,
        ...(this.assign ? { assign: true as const } : {}),
        ...(this.used.length ? { vars: this.used } : {}),
        ...(this.computed ? { computed: true as const } : {}),
        ...(pattern ? { pattern: true as const } : {}),
      });
    this.bare = '';
    this.cur = '';
    this.inWord = false;
    this.quoted = false;
    this.assign = false;
    this.computed = false;
    this.digits = true;
    this.used = [];
  }

  add(text: string, isQuoted: boolean): void {
    this.cur += text;
    this.inWord = true;
    if (isQuoted) this.quoted = true;
    if (isQuoted || !/^[0-9]*$/.test(text)) this.digits = false;
  }

  /** An unquoted expansion's value: split into words at blanks. */
  addUnquoted(v: string): void {
    const from = this.used;
    v.split(/[ \t\n]+/).forEach((part, k) => {
      if (k > 0) {
        this.flush();
        this.used = [...from]; // the words a split expansion makes came from it too
      }
      if (part) this.add(part, false);
    });
  }
}

/** How a command's `$` reads: kept as written, or expanded with `value` (see LexOptions.dollar). */
interface Expander {
  keep: boolean;
  sub: LexOptions['sub'];
  /** A variable's value (undefined: unset; DYN: unknown), noted on the word. */
  value(name: string): string | undefined;
}

/** The expansion at cmd[i] (`$`): [value, index after it, computed]; null when `$` is literal. */
function readExpansion(cmd: string, i: number, { keep, sub, value }: Expander): [string, number, boolean] | null {
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
}

/** The double-quoted string opening at cmd[i]: its text, the index of its closing quote, whether part of it is computed. */
function readDoubleQuoted(cmd: string, i: number, e: Expander): { text: string; end: number; computed: boolean } {
  let j = i + 1;
  let text = '';
  let computed = false;
  let x: [string, number, boolean] | null;
  while (j < cmd.length && cmd[j] !== '"') {
    if (cmd[j] === '\\' && j + 1 < cmd.length && '"\\$`\n'.includes(cmd[j + 1])) {
      if (cmd[j + 1] !== '\n') text += cmd[j + 1];
      j += 2;
    } else if (cmd[j] === '$' && (x = readExpansion(cmd, j, e))) {
      text += x[0];
      if (x[2]) computed = true;
      j = x[1];
    } else if (cmd[j] === '`') {
      const end = closeBacktick(cmd, j);
      e.sub?.(backtickScript(cmd, j, end));
      text += e.keep ? cmd.slice(j, end + 1) : DYN;
      computed = true;
      j = end + 1;
    } else text += cmd[j++];
  }
  return { text, end: j, computed };
}

/**
 * The tokens of ONE command of `cmd` from `from`, and the control operator ending it (see LexOptions for `$`). One
 * command at a time, so a caller expanding variables sees an assignment in the commands after it.
 */
export function lexCommand(cmd: string, from: number, o: LexOptions): { toks: ShellToken[]; next: number } {
  const out: ShellToken[] = [];
  const keep = o.dollar === 'keep';
  const lookup = typeof o.dollar === 'function' ? o.dollar : undefined;
  const sub = o.sub;
  const w = new WordBuilder(out);
  const e: Expander = {
    keep,
    sub,
    value: (name) => {
      const v = lookup?.(name);
      if (v !== DYN) w.used.push(`$${name}`);
      return v;
    },
  };
  /** A command or process substitution's text: kept as written, or DYN. */
  const substituted = (script: string, written: string) => {
    sub?.(script);
    w.add(keep ? written : DYN, false);
    w.computed = true;
  };
  let x: [string, number, boolean] | null;
  for (let i = from; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end < 0 ? cmd.length : end;
      w.add(cmd.slice(i + 1, stop), true);
      i = stop;
    } else if (c === '$' && cmd[i + 1] === "'") {
      const [v, end] = ansiC(cmd, i);
      w.add(v, true);
      i = end;
    } else if (c === '"') {
      const q = readDoubleQuoted(cmd, i, e);
      if (q.computed) w.computed = true;
      w.add(q.text, true);
      i = q.end;
    } else if (c === '\\') {
      if (i + 1 < cmd.length && cmd[i + 1] !== '\n') w.add(cmd[i + 1], true);
      i++;
    } else if (c === '$' && (x = readExpansion(cmd, i, e))) {
      if (x[2]) w.computed = true;
      if (x[0] === DYN || keep) w.add(x[0], false);
      else w.addUnquoted(x[0]);
      i = x[1] - 1;
    } else if (c === '`') {
      const end = closeBacktick(cmd, i);
      substituted(backtickScript(cmd, i, end), cmd.slice(i, end + 1));
      i = end;
    } else if (!o.redirects && (c === '<' || c === '>') && cmd[i + 1] === '(') {
      w.flush(); // `<` and `>` end a word: a process substitution starts one
      const end = closeParen(cmd, i + 1);
      substituted(cmd.slice(i + 2, end - 1), cmd.slice(i, end));
      i = end - 1;
    } else if (c === '#' && !w.inWord) {
      const end = cmd.indexOf('\n', i);
      i = (end < 0 ? cmd.length : end) - 1;
    } else if (c === ' ' || c === '\t') {
      w.flush();
    } else if (o.redirects && (c === '<' || c === '>' || (c === '&' && cmd[i + 1] === '>'))) {
      // A redirect: the digits of a file descriptor before it are part of it, any other word before it ends.
      if (w.inWord && w.digits) {
        w.cur = '';
        w.inWord = false;
      }
      w.flush();
      const op = REDIRECT_OP.exec(cmd.slice(i))?.[0] ?? c;
      out.push({ text: op, redirect: true });
      i += op.length - 1;
    } else if (!o.redirects && c === '&' && /[<>]$/.test(w.cur)) {
      w.add(c, false); // 2>&1
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      w.flush();
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === ';;') {
        out.push({ text: two, op: true });
        return { toks: out, next: i + 2 };
      }
      out.push({ text: c, op: true });
      return { toks: out, next: i + 1 };
    } else {
      if (c === '=' && !w.assign && !w.quoted && /^[A-Za-z_]\w*\+?$/.test(w.cur)) w.assign = true;
      w.add(c, false);
      w.bare += c;
    }
  }
  w.flush();
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
