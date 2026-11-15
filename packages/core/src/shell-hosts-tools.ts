/** The hosts each network tool names (shell-hosts.ts): database clients, downloaders, HTTPie, stores, git, netcat. */
import { computed, conninfoHosts, envValue, optionValue, parseArgs, remoteOperandHost } from './shell-hosts-scan.js';
import type { Collector, Scan, Tok } from './shell-hosts-scan.js';
import {
  CURL_ARG_OPTS,
  CURL_LONG_ARG_OPTS,
  CURL_PROXY_OPTS,
  FILE_EXTENSION,
  GIT_GLOBAL_ARG_OPTS,
  GIT_LONG_ARG_OPTS,
  GIT_REPO_ARG_OPTS,
  HTTPIE_ARG_OPTS,
  HTTPIE_LONG_ARG_OPTS,
  HTTP_METHODS,
  INLINE_CODE,
  LIBPQ,
  NC_ARG_OPTS,
  PG_ARG_OPTS,
  TELNET_ARG_OPTS,
  WGET_ARG_OPTS,
  WGET_LONG_ARG_OPTS,
} from './shell-hosts-tables.js';
import { DYN } from './shell-words.js';

/** The code an interpreter runs inline (`node -e`, `python -c`…): the URLs in it. */
export function inlineCode(name: string, args: Tok[], c: Collector): void {
  for (const [interpreter, codeOpt] of INLINE_CODE) {
    if (!interpreter.test(name)) continue;
    for (let i = 0; i < args.length; i++) {
      const eq = /^(--eval|--print|--run)=([\s\S]*)$/.exec(args[i].text);
      if (eq) c.addUrlsIn(eq[2], `${name} ${eq[1]}`);
      else if (codeOpt.test(args[i].text) && args[i + 1]) c.addUrlsIn(args[i + 1].text, `${name} ${args[i].text}`);
    }
  }
}

/** psql and the libpq tools, mysql and its family: `-h`, conninfo strings, URLs, else the host variables. */
export function databaseHosts(name: string, args: Tok[], s: Scan, scoped: Map<string, string | undefined>): void {
  const { c } = s;
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
}

/** curl / wget options that name a host: proxies, `--resolve`, `--connect-to`, wget `-e *_proxy=`. */
export function downloadOptionHosts(curl: boolean, o: { name: string; value?: string }, targets: string[], c: Collector): void {
  if (o.value === undefined) return;
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

/** curl and wget: their options' hosts, and every operand as a URL. */
export function downloadHosts(name: string, args: Tok[], c: Collector): void {
  const curl = name === 'curl';
  const { opts, operands } = parseArgs(args, curl ? CURL_ARG_OPTS : WGET_ARG_OPTS, curl ? CURL_LONG_ARG_OPTS : WGET_LONG_ARG_OPTS);
  const targets = operands.map((t) => t.text);
  for (const o of opts) downloadOptionHosts(curl, o, targets, c);
  // A URL without its scheme (`curl api.example.com/x` means http://): every operand is a URL.
  for (const w of targets) {
    if (w.includes('://')) continue;
    const m = /^(\[[^\]]+\]|[\w.-]+)(:\d+)?(?:[/?#]|$)/.exec(w);
    if (!m) continue;
    const host = m[1];
    const looksLikeHost =
      host.includes(DYN) ||
      /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i.test(host) ||
      (/\.[a-z]{2,}$/i.test(host) && !FILE_EXTENSION.test(host)) ||
      (/^[a-z][\w-]*$/i.test(host) && (m[2] !== undefined || /[/?#]$/.test(m[0]))); // api:8080, api/reset
    if (looksLikeHost) c.add(host, name);
  }
}

/** HTTPie and xh: `--proxy`, `--resolve`, and the URL operand (after an optional method). */
export function httpieHosts(name: string, args: Tok[], c: Collector): void {
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
}

/** redis-cli, mongosh and mongo: their host option, and a mongo address operand. */
export function storeHosts(name: string, args: Tok[], c: Collector): void {
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
}

/** git: only the commands that name a repository: `git commit -m "deploy@staging: …"` names none. */
export function gitHosts(args: Tok[], c: Collector): void {
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
}

/** nc, netcat and telnet: the proxy and the destination (none when listening). */
export function netcatHosts(name: string, args: Tok[], c: Collector): void {
  const { opts, operands } = parseArgs(args, name === 'telnet' ? TELNET_ARG_OPTS : NC_ARG_OPTS, new Set());
  if (opts.some((o) => o.name === '-l')) return; // listening: no destination
  const proxy = name === 'telnet' ? undefined : opts.find((o) => o.name === '-x')?.value;
  if (proxy) c.addProxy(proxy, `${name} -x`);
  const dest = operands[0];
  if (computed(dest)) c.add(DYN, name);
  else if (dest && !/^\d+$/.test(dest.text)) c.add(dest.text, name);
}
