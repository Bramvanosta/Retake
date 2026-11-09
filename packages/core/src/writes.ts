/**
 * Read-only environments (L1.7, R-ENV-03): which requests write, which writes an environment lets through
 * (`read_only.allow`) or answers (`mocks`), and the policy a read-only run enforces in its browser. Pure helpers,
 * shared by validation (patterns), the hooks (GraphQL bodies) and the runner's write guard.
 */
import { protectedBy } from './access.js';
import type { ProtectedHost, RunAccess } from './access.js';
import { hostMatches, normalizeAllowEntry, normalizeHost, networkHost } from './hosts.js';
import type { ResolvedEnvironment, TimelineWrite, WriteMockSpec, WriteRuleSpec } from './types.js';
import { GUIDE } from './error-kind.js';
import type { ErrorKind } from './error-kind.js';

/** Methods that never write (never stopped). */
export const READ_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/** Every method but GET, HEAD and OPTIONS writes. */
export function isWriteMethod(method: string): boolean {
  return !READ_METHODS.includes(method.toUpperCase());
}

// ── GraphQL (minimal: operation kinds and names of a JSON request body) ──────────────────────────────────────

export interface GraphqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
}

/** What a GraphQL request body asks for. */
export interface GraphqlRequest {
  /** The operations it runs (operationName picks one when the document has several). */
  operations: GraphqlOperation[];
  /** `operationName` of the body, if any. */
  operationName?: string;
  /** No document, only an operation name / hash (a persisted query): what it does cannot be told. */
  persisted: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Operation definitions of a GraphQL document (comments and strings stripped; fragments skipped). */
export function graphqlDocumentOperations(doc: string): GraphqlOperation[] {
  const text = doc
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, ' ');
  const ops: GraphqlOperation[] = [];
  let depth = 0;
  let parens = 0;
  const re = /[{}()]|[_A-Za-z][_0-9A-Za-z]*/g;
  let m: RegExpExecArray | null;
  let pending: GraphqlOperation | null = null;
  let skipping = false;
  let expectName = false;
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (tok === '(' || tok === ')') {
      parens = Math.max(0, parens + (tok === '(' ? 1 : -1));
      expectName = false;
      continue;
    }
    if (parens > 0) continue;
    if (tok === '{') {
      if (depth === 0) {
        if (pending) ops.push(pending);
        else if (!skipping) ops.push({ kind: 'query' });
        pending = null;
        skipping = false;
        expectName = false;
      }
      depth++;
      continue;
    }
    if (tok === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (expectName && pending) {
      pending.name = tok;
      expectName = false;
      continue;
    }
    if (tok === 'query' || tok === 'mutation' || tok === 'subscription') {
      pending = { kind: tok };
      expectName = true;
    } else if (tok === 'fragment') {
      skipping = true;
      pending = null;
    } else {
      expectName = false;
    }
  }
  return ops;
}

/** The keys of a GraphQL request object (a JSON body with others is not GraphQL: a saved filter's `query`, a note). */
const GRAPHQL_KEYS = new Set(['query', 'operationName', 'variables', 'extensions']);

/**
 * Whether a document reads like GraphQL: after comments (and strings), `query` / `mutation` / `subscription` /
 * `fragment`, or a selection set that starts with a field (`{ products …`) or a fragment spread — never a JSON text
 * such as `{"status": "open"}`, nor `{}`.
 */
function looksLikeGraphql(doc: string): boolean {
  const t = doc
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, ' ')
    .replace(/^(?:[\s,\uFEFF]|"")+/, '');
  return /^(?:query|mutation|subscription|fragment)\b/.test(t) || /^\{[\s,]*(?:[_A-Za-z]|\.\.\.)/.test(t);
}

function graphqlOne(v: unknown): GraphqlRequest | null {
  if (!isObj(v) || !Object.keys(v).every((k) => GRAPHQL_KEYS.has(k))) return null;
  const operationName = typeof v.operationName === 'string' && v.operationName ? v.operationName : undefined;
  if (typeof v.query === 'string') {
    if (!looksLikeGraphql(v.query)) return null;
    let operations = graphqlDocumentOperations(v.query);
    if (operations.length === 0) return null;
    if (operationName && operations.length > 1) operations = operations.filter((o) => o.name === operationName);
    return { operations, ...(operationName ? { operationName } : {}), persisted: false };
  }
  if (isObj(v.extensions) && isObj(v.extensions.persistedQuery)) {
    return { operations: [], ...(operationName ? { operationName } : {}), persisted: true };
  }
  return null;
}

/**
 * The GraphQL request(s) of a body: a JSON object `{query, operationName?, variables?, extensions?}` whose `query` is a
 * GraphQL document (or a persisted query: an operation name and `extensions.persistedQuery`), or a batch array of
 * them. Accepts the parsed value or its JSON text; null when it is not GraphQL (another key, a `query` that is not a
 * document: a JSON body that merely has a `query` field writes like any other).
 */
export function graphqlOf(body: unknown): GraphqlRequest[] | null {
  let v = body;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return null;
    try {
      v = JSON.parse(t);
    } catch {
      return null;
    }
  }
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0) return null;
  const out: GraphqlRequest[] = [];
  for (const item of list) {
    const g = graphqlOne(item);
    if (!g) return null;
    out.push(g);
  }
  return out;
}

/** Whether every GraphQL request of a body only reads (queries, no persisted query). */
export function graphqlReadsOnly(requests: readonly GraphqlRequest[]): boolean {
  return requests.every((r) => !r.persisted && r.operations.length > 0 && r.operations.every((o) => o.kind === 'query'));
}

/**
 * The operations of a GraphQL body that write, by name: each mutation / subscription of every request of a batch, a
 * persisted query by its operationName; `undefined` for one without a name (an anonymous mutation, an unknown
 * persisted query, a request whose operation cannot be told).
 */
export function graphqlWriteOperations(requests: readonly GraphqlRequest[]): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (const r of requests) {
    if (r.persisted || r.operations.length === 0) {
      out.push(r.operationName);
      continue;
    }
    for (const o of r.operations) if (o.kind !== 'query') out.push(o.name);
  }
  return out;
}

/** The operation name a write of a GraphQL body is known by: its first non-query operation, else its operationName. */
export function graphqlWriteName(requests: readonly GraphqlRequest[]): string | undefined {
  for (const r of requests) {
    const op = r.operations.find((o) => o.kind !== 'query');
    if (op?.name) return op.name;
    if (r.persisted && r.operationName) return r.operationName;
  }
  return requests.find((r) => r.operationName)?.operationName;
}

// ── Request patterns of `read_only.allow` and `mocks` ────────────────────────────────────────────────────────

/** `"[METHOD ]<page>:/path"` or `"[METHOD ]/path"`, parsed. */
export interface RequestPattern {
  /** As written. */
  source: string;
  /** Upper-case; absent: any write method. */
  method?: string;
  /** Environment page key whose base URL the path is relative to; absent: any guarded host, path from the root. */
  page?: string;
  /** The path glob (no trailing slash, except "/"). */
  path: string;
  /** The path glob as a regular expression (trailing slash optional). */
  regex: RegExp;
}

const PATTERN_HINT = 'write "[METHOD ]<page>:/path" or "[METHOD ]/path", e.g. "POST shop:/api/quotes" or "/api/track"';

function globRegex(path: string): RegExp {
  let re = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '*' && path[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}/?$`);
}

/** Why a request pattern is not usable, or null. */
export function requestPatternError(source: string): string | null {
  try {
    parseRequestPattern(source);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Parse a request pattern; throws an Error whose message says what to write. */
export function parseRequestPattern(source: string): RequestPattern {
  const s = source.trim();
  let method: string | undefined;
  let target = s;
  const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(s);
  if (m) {
    method = m[1].toUpperCase();
    target = m[2].trim();
    if (READ_METHODS.includes(method)) {
      throw new Error(`${method} requests are never stopped on a read-only run: name a write method (POST, PUT, PATCH, DELETE…) or none (${PATTERN_HINT})`);
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) throw new Error(`absolute URLs are not supported in a request pattern: ${PATTERN_HINT}`);
  let page: string | undefined;
  let path = target;
  const pm = /^([A-Za-z_][A-Za-z0-9_-]*):(\/.*)$/.exec(target);
  if (pm) {
    page = pm[1];
    path = pm[2];
  } else if (!target.startsWith('/')) {
    throw new Error(`"${source}" is not a request pattern: ${PATTERN_HINT}`);
  }
  if (/[?#\s]/.test(path)) throw new Error(`a request pattern is a path: no query, fragment or spaces (the query of a request is ignored) — ${PATTERN_HINT}`);
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  return { source, ...(method ? { method } : {}), ...(page ? { page } : {}), path, regex: globRegex(path) };
}

/** Whether a request (method, real URL) matches a pattern; `pages`: the environment's real base URLs. */
export function matchRequestPattern(p: RequestPattern, method: string, url: string, pages: Record<string, string>): boolean {
  if (p.method && p.method !== method.toUpperCase()) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!p.page) return p.regex.test(u.pathname);
  const baseUrl = Object.hasOwn(pages, p.page) ? pages[p.page] : undefined;
  if (!baseUrl) return false;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (base.origin !== u.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (basePath && u.pathname !== basePath && !u.pathname.startsWith(`${basePath}/`)) return false;
  const rel = u.pathname.slice(basePath.length) || '/';
  return p.regex.test(rel);
}

// ── The write policy of a read-only run ──────────────────────────────────────────────────────────────────────

export interface WriteRule {
  /** The pattern as written (`TimelineWrite.rule`). */
  source: string;
  pattern: RequestPattern;
  /** GraphQL operation name the rule is narrowed to. */
  operation?: string;
}

export interface WriteMock extends WriteRule {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  delayMs: number;
  /** Where it comes from. */
  from: 'scenario' | 'environment';
}

/** What a run's browser guard enforces (compileWritePolicy). */
export interface WritePolicy {
  env: string;
  production: boolean;
  /**
   * A read-only run. False: a read-write run that only stops writes to the hosts of the project's read-only
   * environments (`protected`); its other writes are not the guard's (no mocks, no allow entries, nothing recorded).
   */
  readOnly: boolean;
  /** Real base URLs of the environment's pages (patterns `<page>:/path` are relative to them). */
  pages: Record<string, string>;
  /**
   * The run's own guarded host patterns (`*.example.com`, `"*"` = every host): every host on a production environment
   * (fail closed); else the pages' hosts, then `read_only.hosts`; none on a read-write run.
   */
  hosts: string[];
  /** Hosts of other environments this run must not write to (core crossEnvironmentHosts): guarded too. */
  protected: ProtectedHost[];
  /** Page hosts of the environments this run may write to: never protected. */
  writable: string[];
  allow: WriteRule[];
  /** Scenario mocks first, then the environment's. */
  mocks: WriteMock[];
}

function ruleOf(spec: WriteRuleSpec): WriteRule {
  const request = typeof spec === 'string' ? spec : spec.request;
  const operation = typeof spec === 'string' ? undefined : spec.operation;
  return { source: request, pattern: parseRequestPattern(request), ...(operation ? { operation } : {}) };
}

function mockOf(spec: WriteMockSpec, from: WriteMock['from']): WriteMock {
  const json = spec.json !== undefined;
  return {
    ...ruleOf({ request: spec.request, ...(spec.operation ? { operation: spec.operation } : {}) }),
    status: spec.status ?? 200,
    body: json ? JSON.stringify(spec.json) : (spec.body ?? ''),
    contentType: spec.content_type ?? (json ? 'application/json' : 'text/plain'),
    headers: { ...(spec.headers ?? {}) },
    delayMs: spec.delay_ms ?? 0,
    from,
  };
}

/**
 * The browser policy of a run on `env` (`access`: the run's, default read-only). A read-only run guards its own hosts
 * — every host on a production environment (fail closed: a write anywhere needs an allow entry or a mock), else the
 * pages' hosts + `read_only.hosts` — with allow entries and mocks (the scenario's, then the environment's). Every run
 * also guards `access.protected` (the hosts of the project's other read-only environments); a read-write run guards
 * only those. Throws on a malformed pattern (validation refuses them first).
 */
export function compileWritePolicy(
  env: ResolvedEnvironment,
  opts: { scenarioMocks?: readonly WriteMockSpec[]; access?: Pick<RunAccess, 'mode' | 'protected' | 'writable'> } = {},
): WritePolicy {
  const readOnly = (opts.access?.mode ?? 'read-only') === 'read-only';
  const hosts: string[] = [];
  const add = (h: string) => {
    if (h && !hosts.includes(h)) hosts.push(h);
  };
  if (readOnly && env.production === true) add('*');
  else if (readOnly) {
    for (const url of Object.values(env.pages)) {
      const h = networkHost(url);
      if (h) add(h);
    }
    for (const h of env.read_only?.hosts ?? []) add(h.trim() === '*' ? '*' : normalizeAllowEntry(h));
  }
  return {
    env: env.name,
    production: env.production === true,
    readOnly,
    pages: { ...env.pages },
    hosts,
    protected: [...(opts.access?.protected ?? [])],
    writable: [...(opts.access?.writable ?? [])],
    allow: readOnly ? (env.read_only?.allow ?? []).map(ruleOf) : [],
    mocks: readOnly ? [...(opts.scenarioMocks ?? []).map((m) => mockOf(m, 'scenario')), ...(env.read_only?.mocks ?? []).map((m) => mockOf(m, 'environment'))] : [],
  };
}

/** Whether a policy guards anything (a read-only run, or protected hosts of other environments): its browser is armed. */
export function guardsWrites(policy: Pick<WritePolicy, 'readOnly' | 'protected'>): boolean {
  return policy.readOnly || policy.protected.length > 0;
}

/** Every host pattern a policy may guard (its own, then the protected ones): the browser's unload script. */
export function guardedHostPatterns(policy: Pick<WritePolicy, 'hosts' | 'protected'>): string[] {
  return [...new Set([...policy.hosts, ...(policy.protected ?? []).map((p) => p.host)])];
}

/** Whether the policy guards a host: one of its own (exact, `*.suffix`, or `"*"`), or a protected host of another environment. */
export function isGuardedHost(host: string, policy: Pick<WritePolicy, 'hosts'> & Partial<Pick<WritePolicy, 'protected' | 'writable'>>): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return policy.hosts.some((p) => hostMatches(h, p)) || protectedBy(h, policy) !== null;
}

/** A request as the guard sees it. */
export interface WriteRequest {
  method: string;
  url: string;
  /** Request body (text), when it has one. */
  body?: string | null;
}

export type WriteDecision =
  | { write: false }
  | {
      write: true;
      outcome: TimelineWrite['outcome'];
      /** The allow / mock entry that matched. */
      rule?: string;
      mock?: WriteMock;
      /** GraphQL operation name. */
      operation?: string;
      /** The other (read-only) environment whose host it goes to, when only that makes it guarded. */
      protectedBy?: string;
    };

/**
 * Whether an allow / mock entry covers a request. One narrowed to a GraphQL `operation` covers a body only when every
 * operation of it that writes is that one (a batch [RefreshToken, CreateOrder] is not a token refresh).
 */
function ruleMatches(r: WriteRule, req: WriteRequest, policy: WritePolicy, gql: GraphqlRequest[] | null): boolean {
  if (r.operation !== undefined) {
    const ops = gql ? graphqlWriteOperations(gql) : [];
    if (ops.length === 0 || ops.some((o) => o !== r.operation)) return false;
  }
  return matchRequestPattern(r.pattern, req.method, req.url, policy.pages);
}

/**
 * What a run's guard does with a request: reads pass (GET / HEAD / OPTIONS, GraphQL queries sent as POST); a write to
 * a host the policy does not guard passes and is recorded (`passed`) on a read-only run, and is not the guard's at all
 * on a read-write one (`write: false`); a guarded write is answered by the first matching mock (`mocked`), else let
 * through by an allow entry (`allowed`), else stopped (`blocked`). A persisted GraphQL query (no document) is a write
 * unless allowed or mocked by its operation name.
 */
export function classifyRequest(req: WriteRequest, policy: WritePolicy): WriteDecision {
  if (!isWriteMethod(req.method)) return { write: false };
  const gql = req.body ? graphqlOf(req.body) : null;
  if (gql && graphqlReadsOnly(gql)) return { write: false };
  const host = networkHost(req.url);
  if (!host) return { write: false };
  const operation = gql ? graphqlWriteName(gql) : undefined;
  const own = policy.hosts.some((p) => hostMatches(host, p));
  const foreign = own ? null : protectedBy(host, policy);
  const op = { ...(operation ? { operation } : {}), ...(foreign ? { protectedBy: foreign.env } : {}) };
  if (!own && !foreign) return policy.readOnly ? { write: true, outcome: 'passed', ...op } : { write: false };
  const mock = policy.mocks.find((m) => ruleMatches(m, req, policy, gql));
  if (mock) return { write: true, outcome: 'mocked', rule: mock.source, mock, ...op };
  const allow = policy.allow.find((r) => ruleMatches(r, req, policy, gql));
  if (allow) return { write: true, outcome: 'allowed', rule: allow.source, ...op };
  return { write: true, outcome: 'blocked', ...op };
}

/**
 * A write as messages name it, never with its query (it may carry a token): `POST shop:/api/quotes` when the URL is
 * under an environment page's base, else `POST host/path`.
 */
export function describeWriteRequest(method: string, url: string, pages: Record<string, string>): string {
  const m = method.toUpperCase();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${m} ${url.split(/[?#]/)[0]}`;
  }
  let best: { key: string; rel: string; len: number } | null = null;
  for (const [key, baseUrl] of Object.entries(pages)) {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      continue;
    }
    if (base.origin !== u.origin) continue;
    const basePath = base.pathname.replace(/\/+$/, '');
    if (basePath && u.pathname !== basePath && !u.pathname.startsWith(`${basePath}/`)) continue;
    if (!best || basePath.length > best.len) best = { key, rel: u.pathname.slice(basePath.length) || '/', len: basePath.length };
  }
  return best ? `${m} ${best.key}:${best.rel}` : `${m} ${u.host}${u.pathname}`;
}

/**
 * A js hook's write stopped by its tab on a read-only run (runner-web hook-page.ts): the hook failed after it.
 * @retake/hooks turns it into a `HookSecurityError` (reason `read-only`, status `refused`). `writes` are
 * described by describeWriteRequest; `detail` is appended to the message.
 */
export class WriteRefusedError extends Error {
  readonly writes: string[];
  readonly env: string;
  readonly detail?: string;
  /** A read-write run's write to a host of this other, read-only environment (core crossEnvironmentHosts). */
  readonly protectedBy?: string;
  constructor(writes: readonly string[], env: string, options?: { cause?: unknown; detail?: string; protectedBy?: string }) {
    const detail = options?.detail ? `; ${options.detail}` : '';
    const where = options?.protectedBy ? `to a host of read-only environment ${options.protectedBy}` : `on read-only environment ${env}`;
    super(`a js hook wrote ${where} (${writes.join(', ')}): stopped in its tab${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WriteRefusedError';
    this.writes = [...writes];
    this.env = env;
    if (options?.detail) this.detail = options.detail;
    if (options?.protectedBy) this.protectedBy = options.protectedBy;
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'refused';
  }

  get errorDocs(): string {
    return GUIDE.environments;
  }
}

/** Whether an error is a `WriteRefusedError` (also across module copies: checked by name). */
export function isWriteRefusedError(e: unknown): e is WriteRefusedError {
  return e instanceof WriteRefusedError || (e instanceof Error && e.name === 'WriteRefusedError');
}
