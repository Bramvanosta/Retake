/**
 * Hosts a shell hook names (R-SEC-06): the allow-list check of `shell` hooks. A shell hook is a local program, so
 * Retake checks the hosts its command line *names* — URLs, `$VARS` (the script's own assignments over the
 * environment), database-client hosts and PGHOST, ssh / scp / rsync / git destinations, proxies, URLs in inline code
 * (`node -e`, `python3 -c`…) — also inside `sh -c` / `eval`, command substitutions and heredocs, before anything runs.
 * Connections a program makes from its own configuration or code (a `.env` file, ~/.ssh/config, a script file, a host
 * it computes) are not visible here.
 */
import { Collector, firstOperand, lookup, parseArgs, remoteOperandHost, sshHost, stripPort } from './shell-hosts-scan.js';
import type { Scan, Scope, ShellHostOptions, ShellHostRef, Tok } from './shell-hosts-scan.js';
import { DECLARE, HOST_VARS, HTTPIE, LIBPQ, MOSH_ARG_OPTS, MYSQL, PROXY_VARS, RSYNC_ARG_OPTS, SCP_ARG_OPTS, SFTP_ARG_OPTS, SSH_ARG_OPTS } from './shell-hosts-tables.js';
import { databaseHosts, downloadHosts, gitHosts, httpieHosts, inlineCode, netcatHosts, storeHosts } from './shell-hosts-tools.js';
import { DYN, REDIRECT_ALONE, REDIRECT_ATTACHED, SHELLS, commandName, commandWordAt, heredocs, lexCommand, substitutions } from './shell-words.js';

export type { ShellHostOptions, ShellHostRef } from './shell-hosts-scan.js';

/** The tokens of ONE command of `cmd` from `from`, its variables expanded from the scope as it is now (lexCommand). */
function tokenize(cmd: string, from: number, s: Scan, sub?: (script: string) => void): { toks: Tok[]; next: number } {
  return lexCommand(cmd, from, { dollar: (name) => lookup(name, s), ...(sub ? { sub } : {}) });
}

interface Cmd {
  /** Its words, without redirections (files, not hosts). */
  words: Tok[];
  /** A here-string (`<<< word`): what it reads on stdin. */
  herestring?: string;
}

function commandOf(toks: Tok[]): Cmd {
  const words: Tok[] = [];
  let herestring: string | undefined;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op) continue;
    if (REDIRECT_ALONE.test(t.text)) {
      if (t.text.endsWith('<<<')) herestring = toks[i + 1]?.text;
      i++;
    } else if (REDIRECT_ATTACHED.test(t.text)) {
      const m = /^\d*<<<([\s\S]+)$/.exec(t.text);
      if (m) herestring = m[1];
    } else words.push(t);
  }
  return { words, ...(herestring !== undefined ? { herestring } : {}) };
}

/** `-o Key=value` / `-oKey value` / `-o "Key value"` options of ssh-family commands; a ProxyCommand is a script. */
function sshOptionHosts(args: Tok[], tool: string, s: Scan): void {
  const { c } = s;
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    let opt: string | undefined;
    if (w === '-o') opt = args[++i]?.text;
    else if (w.startsWith('-o') && w.length > 2) opt = w.slice(2);
    else if (w === '-J') opt = args[++i] ? `ProxyJump=${args[i].text}` : undefined;
    else if (w.startsWith('-J') && w.length > 2) opt = `ProxyJump=${w.slice(2)}`;
    if (!opt) continue;
    const m = /^\s*(\w+)\s*(?:=|\s)\s*([\s\S]*)$/.exec(opt);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'hostname') c.add(m[2], `${tool} -o HostName`);
    if (key === 'proxyjump' && m[2].toLowerCase() !== 'none') {
      for (const hop of m[2].split(',')) {
        if (!c.addUrl(hop, `${tool} -J`)) c.add(stripPort(sshHost(hop)), `${tool} -J`);
      }
    }
    // `ProxyCommand ssh -W %h:%p bastion`: the command ssh runs to connect.
    if (key === 'proxycommand' && m[2].toLowerCase() !== 'none') scanScript(m[2], { ...s, depth: s.depth + 1 });
  }
}

/** A `NAME=value` / `NAME+=value` assignment into `into`: URL values, proxies and database host variables are hosts. */
function assignment(word: string, s: Scan, into: Map<string, string | undefined>): void {
  const eq = word.indexOf('=');
  const append = word[eq - 1] === '+';
  const name = word.slice(0, append ? eq - 1 : eq);
  const value = (append ? (into.get(name) ?? lookup(name, s) ?? '') : '') + word.slice(eq + 1);
  into.set(name, value);
  hostValue(name, value, s.c, HOST_VARS.has(name) ? name : `${name}=`);
}

/** The host a variable's value names, by the variable's role. */
function hostValue(name: string, value: string, c: Collector, via: string, envKey?: string): void {
  if (HOST_VARS.has(name)) c.addList(value, via, envKey);
  else if (PROXY_VARS.has(name)) c.addProxy(value, via, envKey);
  else c.addUrl(value, via, envKey);
}

/** What a scanned command was, for its neighbours (a heredoc or a pipe feeding a shell). */
interface Ran {
  name: string;
  /** A shell that reads its script on stdin (`sh`, `bash -s`, no `-c`, no script file). */
  stdinShell?: boolean;
  /** echo / printf: the text it writes. */
  echoed?: string;
}

function scanScript(script: string, s: Scan): void {
  if (s.depth > 8) return;
  const sub = (inner: string) => scanScript(inner, { ...s, depth: s.depth + 1 });
  const docs = heredocs(script);
  // The commands of the current line: a heredoc's body is fed to one of them (or through a pipe after it).
  let line: Array<{ from: number; to: number; ran: Ran | null; op?: string }> = [];
  let at = 0;
  while (at < script.length) {
    const { toks, next } = tokenize(script, at, s, sub);
    const last = toks[toks.length - 1];
    const op = last?.op ? last.text : undefined;
    const cmd = commandOf(toks);
    const ran = cmd.words.length ? scanCommand(cmd, s) : null;
    // `echo "curl …" | sh`: what is echoed is the script.
    const prev = line[line.length - 1];
    if (ran?.stdinShell && prev?.op === '|' && prev.ran?.echoed !== undefined) scanScript(prev.ran.echoed, { ...s, depth: s.depth + 1 });
    line.push({ from: at, to: next, ran, op });
    at = next;
    if (op !== '\n' && next < script.length) continue;
    // Heredoc bodies start on the next line: a script when fed to a shell, else data (SQL, JSON…) whose unquoted
    // form still runs its command substitutions.
    const bodies = docs.filter((h) => h.bodyStart === next);
    for (const h of bodies) {
      let k = line.findIndex((l) => h.start >= l.from && h.start < l.to);
      let shell = k >= 0 && line[k].ran?.stdinShell === true;
      while (!shell && k >= 0 && line[k].op === '|' && line[k + 1]) shell = line[++k].ran?.stdinShell === true;
      if (shell) scanScript(h.body, { ...s, depth: s.depth + 1 });
      else if (!h.quoted) substitutions(h.body, sub);
    }
    if (bodies.length) at = Math.max(...bodies.map((h) => h.end));
    line = [];
  }
}

/** Skip assignments, keywords and wrappers (sudo, env, exec, timeout…): the command name and its arguments. */
function commandAt(cmd: Tok[], s: Scan): { name: string; args: Tok[]; scoped: Map<string, string | undefined> } | null {
  const scoped = new Map<string, string | undefined>();
  const i = commandWordAt(cmd, (text) => assignment(text, s, scoped));
  return i < 0 ? null : { name: commandName((cmd[i] as Tok).text), args: cmd.slice(i + 1), scoped };
}

/** URLs anywhere, also as `--opt=URL`; never inside a larger word (SQL, JSON bodies). */
function wordUrls(words: Tok[], c: Collector): void {
  for (const t of words) {
    if (t.assign) continue;
    const via = t.vars?.length ? t.vars[0] : 'URL';
    if (c.addUrl(t.text, via)) continue;
    const opt = /^--?[\w-]+=(.+)$/s.exec(t.text);
    if (opt) c.addUrl(opt[1], via);
  }
}

/** A variable whose value is computed or read from input: unknown from here on. */
function setComputed(scope: Scope, n: string | undefined): void {
  if (n && /^[A-Za-z_]\w*$/.test(n)) scope.local.set(n, DYN);
}

/** The builtins that set or unset variables (and `source`): true when the command is done with. */
function variableCommand(name: string, args: Tok[], s: Scan): boolean {
  const { scope } = s;
  if (DECLARE.has(name)) {
    for (const a of args) {
      if (/^[A-Za-z_]\w*\+?=/.test(a.text)) assignment(a.text, s, scope.local);
      else if (a.text.includes(DYN)) scope.opaque = true; // export $(cat .env | xargs)
    }
    return true;
  }
  if (name === 'unset') {
    for (const a of args) if (!a.text.startsWith('-')) scope.local.set(a.text, undefined);
    return true;
  }
  // Variables set from input or computed: their values are unknown.
  if (name === 'read') {
    const { opts, operands } = parseArgs(args, 'adinNptu', new Set());
    setComputed(scope, opts.find((o) => o.name === '-a')?.value);
    if (!operands.length) setComputed(scope, 'REPLY');
    for (const o of operands) setComputed(scope, o.text);
    return true;
  }
  if (name === 'mapfile' || name === 'readarray') {
    for (const o of parseArgs(args, 'dnOsuCc', new Set()).operands) setComputed(scope, o.text);
    return true;
  }
  if (name === 'printf') {
    const v = parseArgs(args, 'v', new Set()).opts.find((o) => o.name === '-v');
    if (v) setComputed(scope, v.value);
  }
  if (name === 'for' || name === 'select') {
    setComputed(scope, args[0]?.text);
    return true;
  }
  if (name === 'getopts') {
    setComputed(scope, args[1]?.text);
    return true;
  }
  if (name === 'source' || name === '.') {
    scope.opaque = true;
    return true;
  }
  return false;
}

/** `sh -c SCRIPT`, `sh <<< SCRIPT`, `sh` / `sh -s` reading stdin (a heredoc, a pipe), or `sh FILE` (not read). */
function shellCommand(cmd: Cmd, args: Tok[], s: Scan, ran: Ran): void {
  let script: string | undefined;
  let stdin = true;
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (/^[-+][oO]$/.test(w) || w === '--rcfile' || w === '--init-file') i++;
    else if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) {
      script = args[i + 1]?.text ?? '';
      break;
    } else if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(w)) break;
    else if (!/^[-+]/.test(w) || w === '--') {
      stdin = w === '--' && !args[i + 1];
      break;
    }
  }
  const nested = { ...s, depth: s.depth + 1 };
  if (script !== undefined) scanScript(script, nested);
  else if (cmd.herestring !== undefined) scanScript(cmd.herestring, nested);
  else if (stdin) ran.stdinShell = true;
}

/** ssh, sftp, mosh and autossh: their options' hosts and the destination. */
function sshHosts(name: string, args: Tok[], s: Scan): void {
  const { c } = s;
  sshOptionHosts(args, name, s);
  const dest = name === 'mosh' ? firstOperand(args, new Set(), MOSH_ARG_OPTS) : firstOperand(args, name === 'sftp' ? SFTP_ARG_OPTS : SSH_ARG_OPTS);
  if (dest && !c.addUrl(dest.text, name)) {
    const host = name === 'sftp' ? (remoteOperandHost(dest.text, false) ?? sshHost(dest.text)) : sshHost(dest.text);
    c.add(name === 'sftp' ? stripPort(host) : host, name);
  }
}

/** scp and rsync: their options' hosts and every remote operand. */
function copyHosts(name: string, args: Tok[], s: Scan): void {
  const { c } = s;
  sshOptionHosts(args, name, s);
  const argOpts = name === 'scp' ? SCP_ARG_OPTS : RSYNC_ARG_OPTS;
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (w.startsWith('-')) {
      if (!w.startsWith('--') && w.length === 2 && argOpts.has(w[1])) i++;
      continue;
    }
    const host = remoteOperandHost(w, false);
    if (host) c.add(host, name);
  }
}

function scanCommand(cmd: Cmd, s: Scan): Ran | null {
  const { c, scope } = s;
  const words = cmd.words;
  wordUrls(words, c);
  const at = commandAt(words, s);
  if (!at) {
    // Assignment-only command: kept for the rest of the script.
    for (const t of words) if (t.assign) assignment(t.text, { ...s, c: new Collector() }, scope.local);
    return null;
  }
  const { name, args, scoped } = at;
  const ran: Ran = { name };
  if (variableCommand(name, args, s)) return ran;
  if (name === 'echo' || name === 'printf') {
    ran.echoed = args
      .filter((a) => name === 'printf' || !/^-[neE]+$/.test(a.text))
      .map((a) => a.text)
      .join(' ');
    return ran;
  }
  if (SHELLS.has(name)) {
    shellCommand(cmd, args, s, ran);
    return ran;
  }
  if (name === 'eval') {
    if (args.some((a) => a.text.includes(DYN))) scope.opaque = true;
    scanScript(args.map((a) => a.text).join(' '), { ...s, depth: s.depth + 1 });
    return ran;
  }
  inlineCode(name, args, c);
  if (name === 'deno' && args[0]?.text === 'eval') {
    for (const a of args.slice(1)) c.addUrlsIn(a.text, 'deno eval');
    return ran;
  }
  if (LIBPQ.has(name) || MYSQL.has(name)) databaseHosts(name, args, s, scoped);
  else if (name === 'curl' || name === 'wget') downloadHosts(name, args, c);
  else if (HTTPIE.has(name)) httpieHosts(name, args, c);
  else if (name === 'redis-cli' || name === 'mongosh' || name === 'mongo') storeHosts(name, args, c);
  else if (name === 'ssh' || name === 'sftp' || name === 'mosh' || name === 'autossh') sshHosts(name, args, s);
  else if (name === 'scp' || name === 'rsync') copyHosts(name, args, s);
  else if (name === 'git') gitHosts(args, c);
  else if (name === 'nc' || name === 'netcat' || name === 'telnet') netcatHosts(name, args, c);
  return ran;
}

/**
 * Hosts a shell command names, deduplicated: see the module comment. URL credentials never appear in the refs.
 * Refs from `opts.env` carry their `envKey`.
 */
export function shellHostRefs(cmd: string, opts: ShellHostOptions = {}): ShellHostRef[] {
  const c = new Collector();
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (typeof value === 'string') hostValue(key, value, c, `env ${key}`, key);
  }
  scanScript(cmd, { vars: opts.vars, env: opts.env, scope: { local: new Map(), opaque: false }, c, depth: 0 });
  return c.refs;
}
