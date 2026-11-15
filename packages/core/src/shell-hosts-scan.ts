/**
 * The shell-host scan's state and its readers (shell-hosts.ts): the refs it collects, the script's variables, and the
 * getopt-style argument readers the tools share.
 */
import { normalizeHost } from './hosts.js';
import { NETWORK_SCHEMES, URL_IN_TEXT } from './shell-hosts-tables.js';
import { DYN } from './shell-words.js';
import type { ShellToken } from './shell-words.js';
import { decodeOrKeep } from './util.js';

export interface ShellHostRef {
  /** Normalized host ('' when `unresolved`). Never a URL: messages may show it. */
  host: string;
  /** How the command names it: "URL", "$API_BASE", "psql -h", "psql host=", "PGHOST", "ssh", "DATABASE_URL="… */
  via: string;
  /**
   * The host is computed when the command runs (`$(…)`, backticks, a variable the script reads or sources; any
   * `$VAR` of the environment when no variables are given).
   */
  unresolved?: boolean;
  /** Set for a ref found in the hook's own `env:` map: the variable. */
  envKey?: string;
}

export interface ShellHostOptions {
  /**
   * The environment `sh` gets. Given: `$NAME` / `${NAME}` are expanded from the script's own assignments, then from
   * it (unset → empty), and libpq / mysql clients without an explicit host are checked against PGHOST / PGHOSTADDR /
   * MYSQL_HOST. Omitted (validation of the literal text): every other expansion is unresolved.
   */
  vars?: Readonly<Record<string, string | undefined>>;
  /** The hook's own `env:` map: URL values, proxies and PGHOST-like variables are hosts too. */
  env?: Readonly<Record<string, string>>;
}

export type Tok = ShellToken;

/** What the script has done to its variables so far. */
export interface Scope {
  /** Variables it set (assignments, export, read…): their values, DYN where computed; undefined = unset. */
  local: Map<string, string | undefined>;
  /** It sourced a file or eval'd computed text: any other variable may hold anything. */
  opaque: boolean;
}

export interface Scan {
  vars: ShellHostOptions['vars'];
  env: ShellHostOptions['env'];
  scope: Scope;
  c: Collector;
  depth: number;
}

/** `$NAME` as the shell expands it here: the script's own value, else the environment; DYN when unknown. */
export function lookup(name: string, s: Scan): string | undefined {
  if (s.scope.local.has(name)) return s.scope.local.get(name);
  if (s.scope.opaque) return DYN;
  if (s.vars) return s.vars[name];
  return s.env?.[name] ?? DYN;
}

/** A variable a program reads from its environment (PGHOST): undefined when not known to be set. */
export function envValue(name: string, s: Scan, scoped: Map<string, string | undefined>): string | undefined {
  if (scoped.has(name)) return scoped.get(name);
  if (s.scope.local.has(name)) return s.scope.local.get(name);
  if (s.scope.opaque) return DYN;
  return s.vars?.[name] ?? s.env?.[name];
}

export class Collector {
  readonly refs: ShellHostRef[] = [];

  add(host: string, via: string, envKey?: string): void {
    let h = host.trim();
    if (h.includes('%')) h = decodeOrKeep(h);
    if (h.includes(DYN) || h.includes('{{')) {
      if (!this.refs.some((r) => r.unresolved && r.via === via)) this.refs.push({ host: '', via, unresolved: true, ...(envKey ? { envKey } : {}) });
      return;
    }
    if (!h || h.startsWith('/')) return; // unset variable, or a unix socket (local)
    const n = normalizeHost(h);
    if (n && !this.refs.some((r) => r.host === n)) this.refs.push({ host: n, via, ...(envKey ? { envKey } : {}) });
  }

  /** Hosts of a "h1,h2:5432,[::1]:5432" list (a mongo replica set name "rs0/" is dropped). */
  addList(value: string, via: string, envKey?: string): void {
    const v = /^[^/]+\/./.test(value) && !value.includes('://') ? value.slice(value.indexOf('/') + 1) : value;
    for (const part of v.split(',')) this.add(stripPort(part), via, envKey);
  }

  /** Whether `word` is a network URL; its hosts are added. */
  addUrl(word: string, via: string, envKey?: string): boolean {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^]*)$/i.exec(word.trim());
    if (!m || !NETWORK_SCHEMES.has(m[1].toLowerCase())) return false;
    const rest = m[2];
    const cut = rest.search(/[/?#]/);
    const authority = cut < 0 ? rest : rest.slice(0, cut);
    const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
    this.addList(hostPart, via, envKey);
    if (/^postgres(ql)?$/i.test(m[1])) {
      const query = rest.slice(rest.indexOf('?') + 1);
      if (rest.includes('?')) {
        for (const kv of query.split('&')) {
          const [k, v = ''] = kv.split('=');
          if (k === 'host' || k === 'hostaddr') this.addList(decodeOrKeep(v), via, envKey);
        }
      }
    }
    return true;
  }

  /** A proxy: `[scheme://][user@]host[:port]` (any scheme: socks5h://, http://…). */
  addProxy(value: string, via: string, envKey?: string): void {
    const v = value.trim();
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^]*)$/i.exec(v);
    const authority = (m ? m[1] : v).split(/[/?#]/)[0];
    this.add(stripPort(authority.slice(authority.lastIndexOf('@') + 1)), via, envKey);
  }

  /** URLs anywhere in a text (inline code). */
  addUrlsIn(text: string, via: string): void {
    for (const m of text.matchAll(URL_IN_TEXT)) this.addUrl(m[0], via);
  }
}

/** "db.example.com:5432" → "db.example.com"; "[::1]:5432" → "[::1]"; "::1" stays. */
export function stripPort(hostPort: string): string {
  const h = hostPort.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const colons = h.split(':').length - 1;
  return colons === 1 ? h.slice(0, h.indexOf(':')) : h;
}

/** `host=… hostaddr=…` of a libpq keyword/value connection string (the whole word must be one). */
export function conninfoHosts(word: string): string[] | null {
  const re = /\s*([A-Za-z_]+)\s*=\s*('(?:[^'\\]|\\.)*'|[^\s']*)/y;
  const hosts: string[] = [];
  let at = 0;
  let pairs = 0;
  while (at < word.length) {
    re.lastIndex = at;
    const m = re.exec(word);
    if (!m) return /^\s*$/.test(word.slice(at)) && pairs ? hosts : null;
    pairs++;
    at = re.lastIndex;
    const value = m[2].startsWith("'") ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2];
    if (m[1] === 'host' || m[1] === 'hostaddr') hosts.push(value);
  }
  return pairs ? hosts : null;
}

/** Option value of `-h X`, `-hX`, `--host X`, `--host=X` at args[i]: [value, next index], or null. */
export function optionValue(args: Tok[], i: number, short: string, long: string): [string, number] | null {
  const w = args[i].text;
  if (w === short || w === long) return args[i + 1] ? [args[i + 1].text, i + 2] : null;
  if (w.startsWith(`${long}=`)) return [w.slice(long.length + 1), i + 1];
  if (w.startsWith(short) && !w.startsWith('--') && w.length > short.length) return [w.slice(short.length), i + 1];
  return null;
}

export interface ParsedArgs {
  /** Options in order, with their value when they take one (`-xVALUE`, `-x VALUE`, `--opt=VALUE`, `--opt VALUE`). */
  opts: Array<{ name: string; value?: string }>;
  operands: Tok[];
}

/** getopt-style arguments: `shortArgs` are the letters, `longArgs` the long options that take a value. */
export function parseArgs(args: Tok[], shortArgs: string, longArgs: ReadonlySet<string>): ParsedArgs {
  const opts: ParsedArgs['opts'] = [];
  const operands: Tok[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (w === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      if (eq > 0) opts.push({ name: w.slice(0, eq), value: w.slice(eq + 1) });
      else if (longArgs.has(w)) opts.push({ name: w, value: args[++i]?.text });
      else opts.push({ name: w });
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let k = 1; k < w.length; k++) {
        if (!shortArgs.includes(w[k])) {
          opts.push({ name: `-${w[k]}` });
          continue;
        }
        opts.push({ name: `-${w[k]}`, value: k + 1 < w.length ? w.slice(k + 1) : args[++i]?.text });
        break;
      }
      continue;
    }
    operands.push(args[i]);
  }
  return { opts, operands };
}

/** `[user@]host` of an ssh destination. */
export function sshHost(dest: string): string {
  const at = dest.lastIndexOf('@');
  return at < 0 ? dest : dest.slice(at + 1);
}

/** Host of a remote scp / rsync / git operand (`[user@]host:path`, `host::module`), else null. */
export function remoteOperandHost(word: string, needUser: boolean): string | null {
  const m = /^(?:([^@/:\s]+)@)?(\[[^\]]+\]|[^/:@[\s]+):/.exec(word);
  if (!m || (needUser && !m[1])) return null;
  return m[2];
}

/** First operand (not an option, not an option's value) of an ssh-like command. */
export function firstOperand(args: Tok[], argOpts: Set<string>, longArgOpts?: Set<string>): { index: number; text: string } | null {
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (w === '--') return args[i + 1] ? { index: i + 1, text: args[i + 1].text } : null;
    if (w.startsWith('--')) {
      if (longArgOpts?.has(w)) i++;
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let k = 1; k < w.length; k++) {
        if (argOpts.has(w[k])) {
          if (k === w.length - 1) i++;
          break;
        }
      }
      continue;
    }
    return { index: i, text: w };
  }
  return null;
}

/** A computed word in a connection position (a database name, a repository…): refused when it runs. */
export function computed(t: Tok | undefined): boolean {
  return t?.text.startsWith(DYN) ?? false;
}
