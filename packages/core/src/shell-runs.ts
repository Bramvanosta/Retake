/**
 * What a shell script runs, as the destructive-hook guard reads it (core destructive.ts): its commands, the scripts
 * they make a shell — or another program that runs a script or a command string — run, and whether one of those
 * scripts cannot be read exactly.
 *
 * The rule is conservative. A script is followed only when it is exactly in the text: a literal `-c` string, a literal
 * heredoc or here-string, the output of an `echo` / `printf` the guard can evaluate exactly, a literal `eval`, `trap`,
 * `alias`, `env -S`, `watch`, `su -c`, `parallel`, `find -exec` or `xargs` script, a command or process substitution.
 * Whenever a program runs a script that is not — computed, piped from another program, read from a file descriptor
 * or a process substitution, a script file named by a computed path — the run is `unreadable`.
 */
import { REDIRECT_ALONE, REDIRECT_ATTACHED, SHELLS, commandName, commandWordAt, heredocs, lexCommand, lexShell, shellInvocation, substitutions } from './shell-words.js';
import type { Heredoc, ShellCall, ShellCommand, ShellToken } from './shell-words.js';

/** What a script runs (shellRuns). */
export interface ShellRun {
  /** Its commands, heredoc bodies left out. */
  commands: ShellCommand<ShellToken>[];
  /** The scripts it makes a program run, each exactly as that program reads it. */
  scripts: string[];
  /** A program runs a script this text does not show exactly: it counts as computed. */
  unreadable: boolean;
}

/**
 * A name read as a shell at a command's word: a shell, or a name that ends in one after a `-` / `_` or a restricted
 * shell's `r`, with a version (`rbash`, `bash5.2`, `bash-5.2`, `my-zsh`). A name that merely ends in the letters `sh`
 * (`ssh`, `mongosh`) is not one.
 */
function shellLike(name: string): boolean {
  const m = /^(?:[\w+.]*[-_])?r?([a-z]+?)(?:-?[\d.]+)?$/.exec(name);
  return SHELLS.has(name) || (m !== null && SHELLS.has(m[1] as string));
}

const computed = (t: ShellToken | undefined): boolean => t !== undefined && (t.computed === true || t.pattern === true);

/** The escapes `printf`'s format reads exactly as ANSI-C quoting does. */
const EXACT_ESCAPE = /\\(?![\\abfnrtveE0-7xuU])/;

/** Text with ANSI-C escapes read (the lexer's `$'…'`). */
function ansiText(text: string): string {
  return lexShell(`$'${text.replace(/'/g, "\\'")}'`, { dollar: 'keep' })[0]?.text ?? '';
}

/**
 * What `echo` / `printf` print, when the guard can tell exactly: echo without any backslash (shells differ on its
 * escapes); printf with one literal format, no directive but `%%` and only the escapes ANSI-C quoting reads alike.
 */
function printed(words: readonly ShellToken[]): string | undefined {
  const name = commandName(words[0]?.text ?? '');
  const args = words.slice(1);
  if (args.some((t) => t.computed === true)) return undefined;
  if (name === 'echo') {
    const text = args.map((t) => t.text).join(' ');
    return text.includes('\\') ? undefined : text.replace(/^(?:-[neE]+ )+/, '');
  }
  if (name !== 'printf' || args.length !== 1) return undefined;
  const format = (args[0] as ShellToken).text;
  if (format.startsWith('-') || /%(?!%)/.test(format.replace(/%%/g, '')) || EXACT_ESCAPE.test(format)) return undefined;
  return format.split('%%').map(ansiText).join('%');
}

/** A command's words without its redirections, and what it reads on standard input. */
function inputOf(args: readonly ShellToken[]): { words: ShellToken[]; herestring?: ShellToken; input?: 'file' | 'unreadable' } {
  const words: ShellToken[] = [];
  let herestring: ShellToken | undefined;
  let input: 'file' | 'unreadable' | undefined;
  for (let k = 0; k < args.length; k++) {
    const t = args[k] as ShellToken;
    if (t.computed === true && /^[<>]\(/.test(t.text)) words.push(t);
    else if (REDIRECT_ALONE.test(t.text)) {
      const target = args[k + 1];
      if (t.text.endsWith('<<<')) herestring = target ?? { text: '' };
      else if (/^\d*<&$/.test(t.text)) input = 'unreadable';
      else if (/^\d*<$/.test(t.text)) input = computed(target) ? 'unreadable' : 'file';
      k++;
    } else if (REDIRECT_ATTACHED.test(t.text)) {
      const m = /^\d*<<<([\s\S]+)$/.exec(t.text);
      if (m) herestring = { text: m[1] as string, ...(t.computed ? { computed: true as const } : {}) };
      else if (/^\d*<&/.test(t.text)) input = 'unreadable';
      else if (/^\d*<[^<>]/.test(t.text)) input = t.computed ? 'unreadable' : 'file';
    } else words.push(t);
  }
  return { words, ...(herestring ? { herestring } : {}), ...(input ? { input } : {}) };
}

/** A heredoc body the shell passes on as written: a quoted delimiter, or nothing it expands. */
const literalBody = (h: Heredoc): boolean => h.quoted || !/[$`\\]/.test(h.body);

/** Openers and closers of compound commands, at a command's start. */
const OPENERS = new Set(['if', 'while', 'until', 'for', 'select', 'case', '{']);
const CLOSERS = new Set(['fi', 'done', 'esac', '}']);
/** Operators that end a pipeline. */
const PIPELINE_END = new Set([';', '&', '&&', '||', ';;', '\n']);

/** What a script runs: its commands, the scripts they make a program run, and whether one cannot be read (ShellRun). */
export function shellRuns(cmd: string): ShellRun {
  const scripts = new Set<string>();
  const sub = (script: string) => {
    scripts.add(script);
  };
  const commands: ShellCommand<ShellToken>[] = [];
  const docs = heredocs(cmd);
  let unreadable = false;
  /** A script: followed when it is exact, else the run is unreadable. */
  const follow = (script: string | undefined, isComputed = false) => {
    if (script === undefined || isComputed) unreadable = true;
    else scripts.add(script);
  };
  let depth = 0;
  /** The pipeline being read: the depth it started at, what its last element printed exactly, whether the next command receives it. */
  let pipe: { depth: number; upstream: string | undefined; direct: boolean } | undefined;
  let after: string | undefined;
  let at = 0;
  while (at < cmd.length) {
    const { toks, next } = lexCommand(cmd, at, { dollar: 'keep', sub });
    const last = toks[toks.length - 1];
    const op = last?.op ? last.text : undefined;
    const args = op ? toks.slice(0, -1) : toks;
    const heredoc = docs.find((h) => h.start >= at && h.start < next);
    const { words: plain, herestring, input } = inputOf(args);
    const words = plain.map((t) => t.text);
    for (let k = 0; k < words.length && OPENERS.has(words[k] as string); k++) depth++;
    const cw = commandWordAt(plain);
    const name = cw < 0 ? '' : commandName(words[cw] as string);
    const tokenAt = (k: number | undefined) => (k === undefined ? undefined : plain[k]);
    const received = pipe !== undefined && args.length > 0;
    /** What a shell reading its standard input runs. */
    const stdinScript = () => {
      if (herestring) follow(herestring.text, herestring.computed === true);
      else if (heredoc) follow(heredoc.body, !literalBody(heredoc));
      else if (input === 'unreadable') unreadable = true;
      else if (input === 'file') return;
      else if (received && pipe) follow(pipe.direct && pipe.depth === depth ? pipe.upstream : undefined);
    };
    /** A shell at `k` run with its call: its `-c` script, its standard input, or a script file. */
    const shellCall = (call: ShellCall, k: number, readsInput: boolean) => {
      if (call.script !== undefined) follow(call.script, computed(tokenAt(call.scriptAt)));
      else if (call.stdin) {
        if (readsInput) stdinScript();
      } else if (call.fileAt !== undefined && k === cw) {
        const file = tokenAt(call.fileAt);
        if (computed(file) || /^\/dev\/fd\//.test(file?.text ?? '')) unreadable = true;
        else if (file?.text === '/dev/stdin') stdinScript();
      }
    };
    // xargs and parallel feed their input to the command they run; find -exec its file names.
    const prefix = words.slice(0, cw < 0 ? words.length : cw).map(commandName);
    const viaXargs = prefix.indexOf('xargs');
    for (let k = 0; k < words.length; k++) {
      if (k === cw || (k > cw && cw >= 0 && name === 'find')) continue;
      const call = shellInvocation(words, k);
      if (call?.script !== undefined && !computed(tokenAt(call.scriptAt))) scripts.add(call.script); // `echo bash -c 'x'`: followed as before
    }
    const busybox = name === 'busybox' && SHELLS.has(commandName(words[cw + 1] ?? ''));
    if (cw >= 0 && viaXargs >= 0 && shellLike(name)) {
      const replace = xargsReplace(words.slice(viaXargs + 1, cw));
      const call = shellInvocation(words, cw, true) as ShellCall;
      follow(call.script, call.script === undefined || computed(tokenAt(call.scriptAt)) || (replace !== undefined && call.script.includes(replace)));
    } else if (cw >= 0 && (shellLike(name) || busybox)) {
      const k = busybox ? cw + 1 : cw;
      shellCall(shellInvocation(words, k, true) as ShellCall, cw, true);
    } else if (name === 'source' || name === '.') {
      const file = tokenAt(cw + 1);
      if (computed(file) || /^\/dev\/fd\//.test(file?.text ?? '')) unreadable = true;
      else if (file?.text === '/dev/stdin' || file?.text === '-') stdinScript();
    } else if (name === 'eval') follow(words.slice(cw + 1).join(' '), plain.slice(cw + 1).some(computed));
    else if (name === 'trap') {
      const at1 = words[cw + 1] === '--' ? cw + 2 : cw + 1;
      const first = words[at1];
      if (first !== undefined && !first.startsWith('-')) follow(first, computed(tokenAt(at1)));
    } else if (name === 'alias') {
      plain.slice(cw + 1).forEach((t) => {
        if (t.text.includes('=')) follow(t.text.slice(t.text.indexOf('=') + 1), t.computed === true);
      });
    } else if (name === 'su') {
      const c = words.findIndex((w, k) => k > cw && (w === '-c' || w === '--command' || w.startsWith('--command=')));
      if (c < 0) stdinScript();
      else if ((words[c] as string).startsWith('--command=')) follow((words[c] as string).slice(10), computed(tokenAt(c)));
      else follow(words[c + 1], computed(tokenAt(c + 1)));
    } else if (name === 'parallel') {
      let k = cw + 1;
      while (k < words.length && (words[k] as string).startsWith('-')) k++;
      const end = words.findIndex((w, j) => j >= k && (w === ':::' || w === '::::'));
      const run = plain.slice(k, end < 0 ? words.length : end);
      follow(run.length ? run.map((t) => t.text).join(' ') : undefined, run.some(computed) || run.some((t) => t.text.includes('{')));
    } else if (name === 'find') findExec(plain, cw, follow);
    // Wrappers before the command word that run a script themselves.
    for (let k = 0; k < prefix.length; k++) {
      if (prefix[k] === 'env') {
        const split = envSplit(plain, k + 1, prefix.length);
        if (split) follow(split.script, split.computed);
      }
      if (prefix[k] === 'watch' && cw >= 0 && !words.slice(k + 1, cw).some((w) => w === '-x' || w === '--exec' || /^-[a-z]*x/.test(w))) {
        follow(words.slice(cw).join(' '), plain.slice(cw).some(computed));
      }
      if (prefix[k] === 'sudo' && cw < 0 && words.slice(k + 1).some((w) => w === '--shell' || w === '--login' || /^-[A-Za-z]*[si]/.test(w))) stdinScript();
    }
    if (!(cw >= 0 && (shellLike(name) || busybox)) && heredoc && !heredoc.quoted) substitutions(heredoc.body, sub); // the shell expands an unquoted body
    if (args.length) commands.push({ args, ...(after !== undefined ? { after } : {}) });
    for (const w of words) if (CLOSERS.has(w)) depth = Math.max(0, depth - 1);
    if (op === '(') depth++;
    if (op === ')') depth = Math.max(0, depth - 1);
    // The pipeline: `|` starts or continues it (a line break or `&` right after it too), its end at its own depth closes it.
    if (op === '|') {
      const cat = words.length === 1 && words[0] === 'cat' && heredoc && literalBody(heredoc) ? heredoc.body : undefined;
      pipe = { depth, upstream: cat ?? (cw === 0 ? printed(plain) : undefined), direct: true };
    } else if (pipe && args.length === 0 && pipe.direct && (op === '\n' || op === '&')) {
      // `|` then a line break, or `|&`: the next command still receives the pipe
    } else if (pipe) {
      if (args.length) pipe.direct = false;
      if (op !== undefined && PIPELINE_END.has(op) && depth <= pipe.depth) pipe = undefined;
    }
    after = op;
    at = next;
    if (op === '\n') {
      const bodies = docs.filter((h) => h.bodyStart === next);
      if (bodies.length) at = Math.max(...bodies.map((h) => h.end));
    }
  }
  return { commands, scripts: [...scripts], unreadable };
}

/** The replace string of xargs options (`-I X`, `-IX`, `-J X`, `-i`, `--replace[=X]`), if any. */
function xargsReplace(opts: readonly string[]): string | undefined {
  for (let k = 0; k < opts.length; k++) {
    const o = opts[k] as string;
    if (o === '-I' || o === '-J') return opts[k + 1];
    if (/^-[IJ]./.test(o)) return o.slice(2);
    if (o === '-i' || o === '--replace') return '{}';
    if (o.startsWith('--replace=')) return o.slice(10);
    if (/^-i./.test(o)) return o.slice(2);
  }
  return undefined;
}

/** The script of `env -S STRING …` / `-SSTRING` / `--split-string=STRING` among the words before the command word. */
function envSplit(words: readonly ShellToken[], from: number, to: number): { script: string; computed: boolean } | undefined {
  for (let k = from; k < to; k++) {
    const w = (words[k] as ShellToken).text;
    const rest = words.slice(k + 1);
    const head = w === '-S' || w === '--split-string' ? [] : /^-S./.test(w) ? [w.slice(2)] : w.startsWith('--split-string=') ? [w.slice(15)] : undefined;
    if (head === undefined) continue;
    const all = [...(head.length ? [words[k] as ShellToken] : []), ...rest];
    return { script: [...head, ...rest.map((t) => t.text)].join(' '), computed: all.some(computed) };
  }
  return undefined;
}

/** `find … -exec CMD … ;` (and -execdir, -ok, -okdir): a computed command, or a shell given the file names, is unreadable. */
function findExec(words: readonly ShellToken[], cw: number, follow: (script: string | undefined, isComputed?: boolean) => void): void {
  for (let k = cw + 1; k < words.length; k++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes((words[k] as ShellToken).text)) continue;
    let end = k + 1;
    while (end < words.length && !([';', '+'] as string[]).includes((words[end] as ShellToken).text)) end++;
    const group = words.slice(k + 1, end);
    const head = group[0];
    if (head && (computed(head) || head.text.includes('{}'))) follow(undefined);
    else if (head && shellLike(commandName(head.text))) {
      const call = shellInvocation(
        group.map((t) => t.text),
        0,
        true,
      ) as ShellCall;
      follow(call.script, call.script === undefined || computed(group[call.scriptAt as number]) || call.script.includes('{}'));
    }
    k = end;
  }
}
