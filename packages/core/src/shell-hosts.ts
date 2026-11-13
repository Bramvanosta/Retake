/**
 * Hosts a shell hook names (R-SEC-06): the allow-list check of `shell` hooks. A shell hook is a local program, so
 * Retake checks the hosts its command line *names* — URLs, `$VARS` (the script's own assignments over the
 * environment), database-client hosts and PGHOST, ssh / scp / rsync / git destinations, proxies, URLs in inline code
 * (`node -e`, `python3 -c`…) — also inside `sh -c` / `eval`, command substitutions and heredocs, before anything runs.
 * Connections a program makes from its own configuration or code (a `.env` file, ~/.ssh/config, a script file, a host
 * it computes) are not visible here.
 */
import { normalizeHost } from './hosts.js';
import { DYN, REDIRECT_ALONE, REDIRECT_ATTACHED, SHELLS, commandName, commandWordAt, heredocs, lexCommand, substitutions } from './shell-words.js';
import type { ShellToken } from './shell-words.js';

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

/** URL schemes that reach a network host (others — s3://, file://, git+file… — are not checked). */
const NETWORK_SCHEMES = new Set([
  'http',
  'https',
  'ws',
  'wss',
  'ftp',
  'ftps',
  'git',
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'redis',
  'rediss',
  'mongodb',
  'mongodb+srv',
  'ssh',
  'sftp',
  'scp',
  'rsync',
  'amqp',
  'amqps',
]);
/** Variables a database client reads its host from. */
const HOST_VARS = new Set(['PGHOST', 'PGHOSTADDR', 'MYSQL_HOST']);
/** Variables curl, wget, git, pip… send their requests through. */
const PROXY_VARS = new Set(['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'ALL_PROXY']);
const LIBPQ = new Set(['psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pg_isready', 'createdb', 'dropdb', 'vacuumdb', 'reindexdb', 'clusterdb', 'createuser', 'dropuser', 'pg_basebackup']);
const MYSQL = new Set(['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mariadb', 'mariadb-dump', 'mariadb-admin']);
/** psql / pg_dump options that take a value: their first other operand is a database name, conninfo or URL. */
const PG_ARG_OPTS: Record<string, [string, Set<string>]> = {
  psql: [
    'cdfhLoPpRTUvF',
    new Set([
      '--command',
      '--dbname',
      '--file',
      '--host',
      '--log-file',
      '--output',
      '--port',
      '--pset',
      '--record-separator',
      '--table-attr',
      '--username',
      '--set',
      '--variable',
      '--field-separator',
    ]),
  ],
  pg_dump: [
    'dfFjnNtTZEhpUS',
    new Set([
      '--file',
      '--format',
      '--jobs',
      '--schema',
      '--exclude-schema',
      '--table',
      '--exclude-table',
      '--exclude-table-data',
      '--compress',
      '--encoding',
      '--dbname',
      '--host',
      '--port',
      '--username',
      '--role',
      '--section',
      '--lock-wait-timeout',
      '--snapshot',
      '--superuser',
      '--rows-per-insert',
      '--extension',
      '--exclude-extension',
      '--filter',
      '--table-and-children',
      '--exclude-table-and-children',
      '--exclude-table-data-and-children',
    ]),
  ],
};
const DECLARE = new Set(['export', 'readonly', 'declare', 'typeset', 'local']);
/** ssh-family options that take a value (the destination is the first other operand). */
const SSH_ARG_OPTS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));
const SFTP_ARG_OPTS = new Set('BbcDFiJloPRSs'.split(''));
const SCP_ARG_OPTS = new Set('cDFiJloPSX'.split(''));
const RSYNC_ARG_OPTS = new Set('efBMT'.split(''));
/** curl options that take a value (`curl --help all`, curl 8.7, and the newer ones), so a value is not read as a URL. */
const CURL_ARG_OPTS = 'AbcCdDeEFHKmoPQrtTuUwxXyYz';
const CURL_LONG_ARG_OPTS = new Set([
  '--abstract-unix-socket',
  '--alt-svc',
  '--aws-sigv4',
  '--cacert',
  '--capath',
  '--cert',
  '--cert-type',
  '--ciphers',
  '--config',
  '--connect-timeout',
  '--connect-to',
  '--continue-at',
  '--cookie',
  '--cookie-jar',
  '--create-file-mode',
  '--crlfile',
  '--curves',
  '--data',
  '--data-ascii',
  '--data-binary',
  '--data-raw',
  '--data-urlencode',
  '--delegation',
  '--dns-interface',
  '--dns-ipv4-addr',
  '--dns-ipv6-addr',
  '--dns-servers',
  '--doh-url',
  '--dump-header',
  '--ech',
  '--egd-file',
  '--engine',
  '--etag-compare',
  '--etag-save',
  '--expect100-timeout',
  '--form',
  '--form-string',
  '--ftp-account',
  '--ftp-alternative-to-user',
  '--ftp-method',
  '--ftp-port',
  '--ftp-ssl-ccc-mode',
  '--happy-eyeballs-timeout-ms',
  '--haproxy-clientip',
  '--header',
  '--hostpubmd5',
  '--hostpubsha256',
  '--hsts',
  '--interface',
  '--ip-tos',
  '--ipfs-gateway',
  '--json',
  '--keepalive-cnt',
  '--keepalive-time',
  '--key',
  '--key-type',
  '--knownhosts',
  '--krb',
  '--libcurl',
  '--limit-rate',
  '--local-port',
  '--login-options',
  '--mail-auth',
  '--mail-from',
  '--mail-rcpt',
  '--max-filesize',
  '--max-redirs',
  '--max-time',
  '--netrc-file',
  '--noproxy',
  '--oauth2-bearer',
  '--output',
  '--output-dir',
  '--parallel-max',
  '--pass',
  '--pinnedpubkey',
  '--preproxy',
  '--proto',
  '--proto-default',
  '--proto-redir',
  '--proxy',
  '--proxy-cacert',
  '--proxy-capath',
  '--proxy-cert',
  '--proxy-cert-type',
  '--proxy-ciphers',
  '--proxy-crlfile',
  '--proxy-header',
  '--proxy-key',
  '--proxy-key-type',
  '--proxy-pass',
  '--proxy-pinnedpubkey',
  '--proxy-service-name',
  '--proxy-tls13-ciphers',
  '--proxy-tlsauthtype',
  '--proxy-tlspassword',
  '--proxy-tlsuser',
  '--proxy-user',
  '--proxy1.0',
  '--pubkey',
  '--quote',
  '--random-file',
  '--range',
  '--rate',
  '--referer',
  '--request',
  '--request-target',
  '--resolve',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '--sasl-authzid',
  '--service-name',
  '--sigalgs',
  '--socks4',
  '--socks4a',
  '--socks5',
  '--socks5-gssapi-service',
  '--socks5-hostname',
  '--speed-limit',
  '--speed-time',
  '--ssl-sessions',
  '--stderr',
  '--telnet-option',
  '--tftp-blksize',
  '--time-cond',
  '--tls-max',
  '--tls13-ciphers',
  '--tlsauthtype',
  '--tlspassword',
  '--tlsuser',
  '--trace',
  '--trace-ascii',
  '--trace-config',
  '--unix-socket',
  '--upload-file',
  '--upload-flags',
  '--url',
  '--url-query',
  '--user',
  '--user-agent',
  '--variable',
  '--vlan-priority',
  '--write-out',
]);
/** curl options whose value is a proxy every request goes through. */
const CURL_PROXY_OPTS = new Set(['-x', '--proxy', '--preproxy', '--proxy1.0', '--socks4', '--socks4a', '--socks5', '--socks5-hostname']);
/** wget options that take a value (GNU Wget manual). */
const WGET_ARG_OPTS = 'aABDeiIlOoPQRtTUwX';
const WGET_LONG_ARG_OPTS = new Set([
  '--execute',
  '--output-file',
  '--append-output',
  '--input-file',
  '--base',
  '--config',
  '--rejected-log',
  '--report-speed',
  '--bind-address',
  '--bind-dns-address',
  '--dns-servers',
  '--tries',
  '--output-document',
  '--backups',
  '--progress',
  '--timeout',
  '--dns-timeout',
  '--connect-timeout',
  '--read-timeout',
  '--limit-rate',
  '--wait',
  '--waitretry',
  '--quota',
  '--restrict-file-names',
  '--user',
  '--password',
  '--use-askpass',
  '--prefer-family',
  '--local-encoding',
  '--remote-encoding',
  '--retry-on-http-error',
  '--compression',
  '--start-pos',
  '--directory-prefix',
  '--cut-dirs',
  '--default-page',
  '--http-user',
  '--http-password',
  '--header',
  '--max-redirect',
  '--proxy-user',
  '--proxy-password',
  '--referer',
  '--save-cookies',
  '--load-cookies',
  '--user-agent',
  '--post-data',
  '--post-file',
  '--method',
  '--body-data',
  '--body-file',
  '--hsts-file',
  '--secure-protocol',
  '--certificate',
  '--certificate-type',
  '--private-key',
  '--private-key-type',
  '--ca-certificate',
  '--ca-directory',
  '--crl-file',
  '--pinnedpubkey',
  '--random-file',
  '--egd-file',
  '--ciphers',
  '--ftp-user',
  '--ftp-password',
  '--level',
  '--accept-regex',
  '--reject-regex',
  '--regex-type',
  '--accept',
  '--reject',
  '--domains',
  '--exclude-domains',
  '--follow-tags',
  '--ignore-tags',
  '--include-directories',
  '--exclude-directories',
  '--warc-file',
  '--warc-header',
  '--warc-max-size',
  '--warc-dedup',
  '--warc-tempdir',
  '--metalink-index',
  '--input-metalink',
]);
/** HTTPie (`http`, `https`) and xh (`xh`, `xhs`): `[METHOD] URL [ITEM…]`, `:3000/x` meaning localhost. */
const HTTPIE = new Set(['http', 'https', 'xh', 'xhs']);
const HTTPIE_ARG_OPTS = 'aAopPs';
const HTTPIE_LONG_ARG_OPTS = new Set([
  '--auth',
  '--auth-type',
  '--output',
  '--print',
  '--history-print',
  '--style',
  '--session',
  '--session-read-only',
  '--verify',
  '--cert',
  '--cert-key',
  '--cert-key-pass',
  '--proxy',
  '--timeout',
  '--max-redirects',
  '--pretty',
  '--format-options',
  '--boundary',
  '--default-scheme',
  '--ssl',
  '--ciphers',
  '--response-charset',
  '--response-mime',
  '--raw',
  '--bearer',
  '--resolve',
  '--interface',
  '--http-version',
  '--unix-socket',
  '--max-headers',
]);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
/** git: global options with a separate value, and the options of the commands that name a repository. */
const GIT_GLOBAL_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const GIT_REPO_ARG_OPTS: Record<string, string> = { clone: 'bcjou', fetch: 'jo', pull: 'josX', push: 'o', 'ls-remote': 'o' };
const GIT_LONG_ARG_OPTS = new Set([
  '--branch',
  '--origin',
  '--config',
  '--jobs',
  '--upload-pack',
  '--depth',
  '--deepen',
  '--shallow-since',
  '--shallow-exclude',
  '--reference',
  '--reference-if-able',
  '--separate-git-dir',
  '--template',
  '--filter',
  '--server-option',
  '--push-option',
  '--receive-pack',
  '--exec',
  '--strategy',
  '--strategy-option',
  '--negotiation-tip',
  '--recurse-submodules-default',
  '--refmap',
  '--bundle-uri',
  '--repo',
  '--name',
]);
const MOSH_ARG_OPTS = new Set(['-p', '--port', '--ssh', '--server', '--client', '--predict', '--family', '--bind-server', '--experimental-remote-ip']);
/** netcat (BSD / macOS) and telnet options that take a value; the destination is the first other operand. */
const NC_ARG_OPTS = 'bIiMmOpsTVwXx';
const TELNET_ARG_OPTS = 'beklnSsX';
/**
 * Interpreters whose inline code is read for URLs (`node -e CODE`, `python3 -c CODE`…): the command name, and the
 * options whose value is code (a cluster ending with the code letter: `perl -ne`, `ruby -pe`).
 */
const INLINE_CODE: Array<[RegExp, RegExp]> = [
  [/^(node|nodejs|bun)$/, /^(-[a-zA-Z]*[ep]|--eval|--print)$/],
  [/^(python|pypy)[\d.]*$/, /^-[a-zA-Z]*c$/],
  [/^(ruby|lua|luajit|julia|Rscript|osascript)$/, /^(-[a-zA-Z]*e|--eval)$/],
  [/^perl$/, /^-[a-zA-Z]*[eE]$/],
  [/^php$/, /^(-r|--run)$/],
  [/^(mongosh|mongo)$/, /^--eval$/],
];
/** scheme://… inside a larger text (inline code); network schemes only, as everywhere. */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>(){}\\,;]+/gi;
/** File extensions that are not top-level domains: `curl … data.json` is a file an unknown option took, not a host. */
const FILE_EXTENSION =
  /\.(json|jsonl|ndjson|txt|xml|csv|tsv|pem|crt|cer|der|p12|pfx|key|netrc|log|html?|sql|ya?ml|cfg|conf|ini|out|tmp|bin|dat|gz|tgz|tar|bz2|xz|js|mjs|cjs|ts|env|lock|pdf|png|jpe?g|gif|webp|svg)$/i;

type Tok = ShellToken;

/** What the script has done to its variables so far. */
interface Scope {
  /** Variables it set (assignments, export, read…): their values, DYN where computed; undefined = unset. */
  local: Map<string, string | undefined>;
  /** It sourced a file or eval'd computed text: any other variable may hold anything. */
  opaque: boolean;
}

interface Scan {
  vars: ShellHostOptions['vars'];
  env: ShellHostOptions['env'];
  scope: Scope;
  c: Collector;
  depth: number;
}

/** `$NAME` as the shell expands it here: the script's own value, else the environment; DYN when unknown. */
function lookup(name: string, s: Scan): string | undefined {
  if (s.scope.local.has(name)) return s.scope.local.get(name);
  if (s.scope.opaque) return DYN;
  if (s.vars) return s.vars[name];
  return s.env?.[name] ?? DYN;
}

/** A variable a program reads from its environment (PGHOST): undefined when not known to be set. */
function envValue(name: string, s: Scan, scoped: Map<string, string | undefined>): string | undefined {
  if (scoped.has(name)) return scoped.get(name);
  if (s.scope.local.has(name)) return s.scope.local.get(name);
  if (s.scope.opaque) return DYN;
  return s.vars?.[name] ?? s.env?.[name];
}

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

class Collector {
  readonly refs: ShellHostRef[] = [];

  add(host: string, via: string, envKey?: string): void {
    let h = host.trim();
    try {
      if (h.includes('%')) h = decodeURIComponent(h);
    } catch {
      /* keep it as written */
    }
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
          if (k === 'host' || k === 'hostaddr') this.addList(safeDecode(v), via, envKey);
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

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "db.example.com:5432" → "db.example.com"; "[::1]:5432" → "[::1]"; "::1" stays. */
function stripPort(hostPort: string): string {
  const h = hostPort.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const colons = h.split(':').length - 1;
  return colons === 1 ? h.slice(0, h.indexOf(':')) : h;
}

/** `host=… hostaddr=…` of a libpq keyword/value connection string (the whole word must be one). */
function conninfoHosts(word: string): string[] | null {
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
function optionValue(args: Tok[], i: number, short: string, long: string): [string, number] | null {
  const w = args[i].text;
  if (w === short || w === long) return args[i + 1] ? [args[i + 1].text, i + 2] : null;
  if (w.startsWith(`${long}=`)) return [w.slice(long.length + 1), i + 1];
  if (w.startsWith(short) && !w.startsWith('--') && w.length > short.length) return [w.slice(short.length), i + 1];
  return null;
}

interface ParsedArgs {
  /** Options in order, with their value when they take one (`-xVALUE`, `-x VALUE`, `--opt=VALUE`, `--opt VALUE`). */
  opts: Array<{ name: string; value?: string }>;
  operands: Tok[];
}

/** getopt-style arguments: `shortArgs` are the letters, `longArgs` the long options that take a value. */
function parseArgs(args: Tok[], shortArgs: string, longArgs: ReadonlySet<string>): ParsedArgs {
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
function sshHost(dest: string): string {
  const at = dest.lastIndexOf('@');
  return at < 0 ? dest : dest.slice(at + 1);
}

/** Host of a remote scp / rsync / git operand (`[user@]host:path`, `host::module`), else null. */
function remoteOperandHost(word: string, needUser: boolean): string | null {
  const m = /^(?:([^@/:\s]+)@)?(\[[^\]]+\]|[^/:@[\s]+):/.exec(word);
  if (!m || (needUser && !m[1])) return null;
  return m[2];
}

/** First operand (not an option, not an option's value) of an ssh-like command. */
function firstOperand(args: Tok[], argOpts: Set<string>, longArgOpts?: Set<string>): { index: number; text: string } | null {
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

/** A computed word in a connection position (a database name, a repository…): refused when it runs. */
function computed(t: Tok | undefined): boolean {
  return t !== undefined && t.text.startsWith(DYN);
}

function scanCommand(cmd: Cmd, s: Scan): Ran | null {
  const { c, scope } = s;
  const words = cmd.words;
  // URLs anywhere, also as `--opt=URL`; never inside a larger word (SQL, JSON bodies).
  for (const t of words) {
    if (t.assign) continue;
    const via = t.vars?.length ? t.vars[0] : 'URL';
    if (c.addUrl(t.text, via)) continue;
    const opt = /^--?[\w-]+=(.+)$/s.exec(t.text);
    if (opt) c.addUrl(opt[1], via);
  }
  const at = commandAt(words, s);
  if (!at) {
    // Assignment-only command: kept for the rest of the script.
    for (const t of words) if (t.assign) assignment(t.text, { ...s, c: new Collector() }, scope.local);
    return null;
  }
  const { name, args, scoped } = at;
  const ran: Ran = { name };
  const setComputed = (n: string | undefined) => {
    if (n && /^[A-Za-z_]\w*$/.test(n)) scope.local.set(n, DYN);
  };

  if (DECLARE.has(name)) {
    for (const a of args) {
      if (/^[A-Za-z_]\w*\+?=/.test(a.text)) assignment(a.text, s, scope.local);
      else if (a.text.includes(DYN)) scope.opaque = true; // export $(cat .env | xargs)
    }
    return ran;
  }
  if (name === 'unset') {
    for (const a of args) if (!a.text.startsWith('-')) scope.local.set(a.text, undefined);
    return ran;
  }
  // Variables set from input or computed: their values are unknown.
  if (name === 'read') {
    const { opts, operands } = parseArgs(args, 'adinNptu', new Set());
    setComputed(opts.find((o) => o.name === '-a')?.value);
    if (!operands.length) setComputed('REPLY');
    for (const o of operands) setComputed(o.text);
    return ran;
  }
  if (name === 'mapfile' || name === 'readarray') {
    for (const o of parseArgs(args, 'dnOsuCc', new Set()).operands) setComputed(o.text);
    return ran;
  }
  if (name === 'printf') {
    const v = parseArgs(args, 'v', new Set()).opts.find((o) => o.name === '-v');
    if (v) setComputed(v.value);
  }
  if (name === 'for' || name === 'select') {
    setComputed(args[0]?.text);
    return ran;
  }
  if (name === 'getopts') {
    setComputed(args[1]?.text);
    return ran;
  }
  if (name === 'source' || name === '.') {
    scope.opaque = true;
    return ran;
  }
  if (name === 'echo' || name === 'printf') {
    ran.echoed = args
      .filter((a) => name === 'printf' || !/^-[neE]+$/.test(a.text))
      .map((a) => a.text)
      .join(' ');
    return ran;
  }
  if (SHELLS.has(name)) {
    // `sh -c SCRIPT`, `sh <<< SCRIPT`, `sh` / `sh -s` reading stdin (a heredoc, a pipe), or `sh FILE` (not read).
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
    return ran;
  }
  if (name === 'eval') {
    if (args.some((a) => a.text.includes(DYN))) scope.opaque = true;
    scanScript(args.map((a) => a.text).join(' '), { ...s, depth: s.depth + 1 });
    return ran;
  }
  for (const [interpreter, codeOpt] of INLINE_CODE) {
    if (!interpreter.test(name)) continue;
    for (let i = 0; i < args.length; i++) {
      const eq = /^(--eval|--print|--run)=([\s\S]*)$/.exec(args[i].text);
      if (eq) c.addUrlsIn(eq[2], `${name} ${eq[1]}`);
      else if (codeOpt.test(args[i].text) && args[i + 1]) c.addUrlsIn(args[i + 1].text, `${name} ${args[i].text}`);
    }
  }
  if (name === 'deno' && args[0]?.text === 'eval') {
    for (const a of args.slice(1)) c.addUrlsIn(a.text, 'deno eval');
    return ran;
  }
  if (LIBPQ.has(name) || MYSQL.has(name)) {
    const before = c.refs.length;
    let explicit = false;
    for (let i = 0; i < args.length; ) {
      const v = optionValue(args, i, '-h', '--host');
      if (v) {
        explicit = true;
        c.addList(v[0], `${name} -h`);
        i = v[1];
        continue;
      }
      const w = args[i].text;
      const dbname = LIBPQ.has(name) ? (optionValue(args, i, '-d', '--dbname') ?? null) : null;
      const target = dbname ? dbname[0] : w;
      const info = conninfoHosts(target);
      if (info) {
        for (const h of info) {
          explicit = true;
          c.addList(h, `${name} host=`);
        }
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) explicit = true;
      else if (dbname && target.startsWith(DYN)) {
        explicit = true;
        c.add(DYN, `${name} -d`); // a computed database name may be a URL or a conninfo string
      }
      i = dbname ? dbname[1] : i + 1;
    }
    const pg = PG_ARG_OPTS[name];
    if (pg && computed(parseArgs(args, pg[0], pg[1]).operands[0])) {
      explicit = true;
      c.add(DYN, `${name} dbname`);
    }
    if (!explicit && c.refs.length === before) {
      for (const v of LIBPQ.has(name) ? ['PGHOST', 'PGHOSTADDR'] : ['MYSQL_HOST']) {
        const h = envValue(v, s, scoped);
        if (h) c.addList(h, `${v} for ${name}`);
      }
    }
    return ran;
  }
  if (name === 'curl' || name === 'wget') {
    const curl = name === 'curl';
    const { opts, operands } = parseArgs(args, curl ? CURL_ARG_OPTS : WGET_ARG_OPTS, curl ? CURL_LONG_ARG_OPTS : WGET_LONG_ARG_OPTS);
    const targets = operands.map((t) => t.text);
    for (const o of opts) {
      if (o.value === undefined) continue;
      if (curl && o.name === '--url') targets.push(o.value);
      else if (curl && CURL_PROXY_OPTS.has(o.name)) c.addProxy(o.value, `curl ${o.name}`);
      else if (curl && o.name === '--resolve') {
        // [+]host:port:addr[,addr]…: curl connects to the addresses.
        const m = /^\+?(?:\[[^\]]*\]|[^:]*):[^:]*:([\s\S]*)$/.exec(o.value);
        for (const a of m ? m[1].split(',') : []) c.add(a.trim(), 'curl --resolve');
      } else if (curl && o.name === '--connect-to') {
        // HOST1:PORT1:HOST2:PORT2: curl connects to HOST2 (empty: HOST1, the URL's).
        const m = /^(?:\[[^\]]*\]|[^:]*):[^:]*:(\[[^\]]*\]|[^:]*):/.exec(o.value);
        if (m?.[1]) c.add(m[1], 'curl --connect-to');
      } else if (!curl && (o.name === '-e' || o.name === '--execute')) {
        const m = /^\s*((?:https?|ftp)_proxy)\s*=\s*(\S+)/i.exec(o.value);
        if (m) c.addProxy(m[2], `wget -e ${m[1]}`);
      }
    }
    // A URL without its scheme (`curl api.example.com/x` means http://): every operand is a URL.
    for (const w of targets) {
      if (w.includes('://')) continue;
      const m = /^(\[[^\]]+\]|[\w.\uE000-]+)(:\d+)?(?:[/?#]|$)/.exec(w);
      if (!m) continue;
      const host = m[1];
      const looksLikeHost =
        host.includes(DYN) ||
        /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i.test(host) ||
        (/\.[a-z]{2,}$/i.test(host) && !FILE_EXTENSION.test(host)) ||
        (/^[a-z][\w-]*$/i.test(host) && (m[2] !== undefined || /[/?#]$/.test(m[0]))); // api:8080, api/reset
      if (looksLikeHost) c.add(host, name);
    }
    return ran;
  }
  if (HTTPIE.has(name)) {
    const { opts, operands } = parseArgs(args, HTTPIE_ARG_OPTS, HTTPIE_LONG_ARG_OPTS);
    for (const o of opts) {
      if (o.value === undefined) continue;
      // --proxy=http:http://host:3128 (protocol:URL); xh --resolve host:address.
      if (o.name === '--proxy') c.addProxy(o.value.replace(/^[a-z]+:(?!\/\/)/i, ''), `${name} --proxy`);
      if (o.name === '--resolve') c.add(o.value.slice(o.value.indexOf(':') + 1), `${name} --resolve`);
    }
    const first = operands[0];
    const url = operands.length > 1 && first && /^[A-Za-z]+$/.test(first.text) && (first.text === first.text.toUpperCase() || HTTP_METHODS.has(first.text.toLowerCase())) ? operands[1] : first;
    if (url && !url.text.includes('://') && !url.text.startsWith(':')) {
      const m = /^(\[[^\]]+\]|[^/:?#]+)/.exec(url.text);
      if (m) c.add(m[1], name);
    }
    return ran;
  }
  if (name === 'redis-cli' || name === 'mongosh' || name === 'mongo') {
    for (let i = 0; i < args.length; i++) {
      const v = optionValue(args, i, name === 'redis-cli' ? '-h' : '--host', '--host');
      if (v) {
        c.addList(v[0], `${name} ${name === 'redis-cli' ? '-h' : '--host'}`);
        i = v[1] - 1;
      }
    }
    if (name !== 'redis-cli') {
      // `mongosh [address] [file.js…]`: an address is a URL, `host[:port]/db` or a database name.
      const longArgs = new Set([
        '--host',
        '--port',
        '--username',
        '--password',
        '--authenticationDatabase',
        '--authenticationMechanism',
        '--eval',
        '--file',
        '--tlsCAFile',
        '--tlsCertificateKeyFile',
        '--tlsCertificateKeyFilePassword',
        '--apiVersion',
      ]);
      const address = parseArgs(args, 'upf', longArgs).operands.find((t) => !/\.(js|mongodb)$/.test(t.text));
      if (computed(address)) c.add(DYN, `${name} address`);
      else if (address && !address.text.includes('://') && /^[^/]+\/./.test(address.text)) c.addList(address.text.split('/')[0], `${name} address`);
    }
    return ran;
  }
  if (name === 'ssh' || name === 'sftp' || name === 'mosh' || name === 'autossh') {
    sshOptionHosts(args, name, s);
    const dest = name === 'mosh' ? firstOperand(args, new Set(), MOSH_ARG_OPTS) : firstOperand(args, name === 'sftp' ? SFTP_ARG_OPTS : SSH_ARG_OPTS);
    if (dest && !c.addUrl(dest.text, name)) {
      const host = name === 'sftp' ? (remoteOperandHost(dest.text, false) ?? sshHost(dest.text)) : sshHost(dest.text);
      c.add(name === 'sftp' ? stripPort(host) : host, name);
    }
    return ran;
  }
  if (name === 'scp' || name === 'rsync') {
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
    return ran;
  }
  if (name === 'git') {
    // Only the commands that name a repository: `git commit -m "deploy@staging: …"` names none.
    let i = 0;
    while (i < args.length && args[i].text.startsWith('-')) i += GIT_GLOBAL_ARG_OPTS.has(args[i].text) ? 2 : 1;
    const command = args[i]?.text ?? '';
    const rest = args.slice(i + 1);
    const repository = (t: Tok | string | undefined, via: string) => {
      const w = typeof t === 'string' ? t : t?.text;
      if (w === undefined || w.includes('://')) return; // a URL: read above
      if (w.startsWith(DYN)) c.add(DYN, via);
      const host = remoteOperandHost(w, false);
      if (host) c.add(host, via);
    };
    if (GIT_REPO_ARG_OPTS[command] !== undefined) {
      const parsed = parseArgs(rest, GIT_REPO_ARG_OPTS[command], GIT_LONG_ARG_OPTS);
      repository(parsed.operands[0], `git ${command}`);
      repository(parsed.opts.find((o) => o.name === '--repo')?.value, `git ${command}`);
    } else if (command === 'remote' || command === 'submodule') {
      const ops = parseArgs(rest, 'tmb', GIT_LONG_ARG_OPTS).operands;
      if (command === 'remote' && (ops[0]?.text === 'add' || ops[0]?.text === 'set-url')) repository(ops[2], 'git remote');
      if (command === 'submodule' && ops[0]?.text === 'add') repository(ops[1], 'git submodule');
    }
    return ran;
  }
  if (name === 'nc' || name === 'netcat' || name === 'telnet') {
    const { opts, operands } = parseArgs(args, name === 'telnet' ? TELNET_ARG_OPTS : NC_ARG_OPTS, new Set());
    if (opts.some((o) => o.name === '-l')) return ran; // listening: no destination
    const proxy = name === 'telnet' ? undefined : opts.find((o) => o.name === '-x')?.value;
    if (proxy) c.addProxy(proxy, `${name} -x`);
    const dest = operands[0];
    if (computed(dest)) c.add(DYN, name);
    else if (dest && !/^\d+$/.test(dest.text)) c.add(dest.text, name);
    return ran;
  }
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
