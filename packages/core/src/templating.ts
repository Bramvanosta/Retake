import { formatPath } from './issues.js';
import type { IssuePath } from './issues.js';
import { GUIDE } from './error-kind.js';
import type { ErrorKind } from './error-kind.js';

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'invalid';
  }

  get errorDocs(): string {
    return GUIDE.scenarios;
  }
}

/** Resolves `env:VAR` / `keychain:service/account` references to secret values. */
export type SecretResolver = (ref: string) => string | undefined;

export interface TemplateContext {
  /** Environment page key → base URL ({{admin}}, {{app}}). */
  pages?: Record<string, string>;
  /** {{vars.x}} and bare {{x}}. */
  vars?: Record<string, unknown>;
  /** Saved hook results: {{hooks.name.json.id}}. */
  hooks?: Record<string, unknown>;
  /** {{run.id}}, {{run.dir}}. */
  run?: Record<string, unknown>;
  /** Any extra root objects ({{response.json.id}} in rollbacks…). */
  extra?: Record<string, unknown>;
  /**
   * Synchronous secret lookup for {{env:X}} / {{keychain:a/b}}. Defaults to env-only resolution;
   * keychain refs require a resolver that was pre-filled with `prefetchSecrets`.
   */
  secrets?: SecretResolver;
  /** Collects the secret values that were substituted (for log redaction). */
  usedSecrets?: Set<string>;
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

const has = (o: object | undefined, k: string): boolean => o !== undefined && Object.hasOwn(o, k);

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function availableKeys(ctx: TemplateContext): string[] {
  const keys: string[] = [];
  for (const k of Object.keys(ctx.pages ?? {})) keys.push(k);
  for (const k of Object.keys(ctx.vars ?? {})) keys.push(`vars.${k}`);
  for (const k of Object.keys(ctx.hooks ?? {})) keys.push(`hooks.${k}`);
  if (ctx.run) keys.push(...Object.keys(ctx.run).map((k) => `run.${k}`));
  for (const k of Object.keys(ctx.extra ?? {})) keys.push(k);
  keys.push('env:VAR', 'keychain:service/account');
  return keys;
}

/** What a secret reference reads without a resolver: `env:VAR` from this process's environment, nothing else. */
export function defaultSecrets(ref: string): string | undefined {
  if (ref.startsWith('env:')) return process.env[ref.slice(4)];
  return undefined;
}

function lookup(expr: string, ctx: TemplateContext): unknown {
  if (/^(env|keychain|secret|compose_env):/.test(expr)) {
    const ref = expr.startsWith('secret:') ? expr.slice(7) : expr;
    const v = (ctx.secrets ?? defaultSecrets)(ref);
    if (v === undefined) {
      throw new TemplateError(
        ref.startsWith('env:')
          ? `environment variable ${ref.slice(4)} is not set (referenced as {{${expr}}})`
          : ref.startsWith('compose_env:')
            ? `{{${expr}}} is read from a sandbox's compose env file: only the hooks of a sandbox environment and the accounts of its sandbox.yaml resolve it`
          : `secret {{${expr}}} could not be resolved (keychain refs must be prefetched with resolveSecretRef)`,
      );
    }
    ctx.usedSecrets?.add(v);
    return v;
  }
  const path = expr.split('.').map((s) => s.trim());
  const head = path[0];
  if (path.length === 1 && has(ctx.pages, head)) return ctx.pages![head];
  if (head === 'vars') return getPath(ctx.vars, path.slice(1));
  if (head === 'hooks') return getPath(ctx.hooks, path.slice(1));
  if (head === 'run') return getPath(ctx.run, path.slice(1));
  if (has(ctx.extra, head)) return getPath(ctx.extra![head], path.slice(1));
  if (has(ctx.vars, head)) return getPath(ctx.vars, path);
  return undefined;
}

/**
 * Replace {{key}} tokens. Unknown keys throw a TemplateError listing the available keys.
 * A string that is exactly one token keeps the value's string form.
 */
export function interpolate(text: string, ctx: TemplateContext): string {
  return text.replace(TOKEN, (_m, expr: string) => {
    const v = lookup(expr, ctx);
    if (v === undefined) {
      throw new TemplateError(`unknown template key {{${expr}}}; available: ${availableKeys(ctx).join(', ')}`);
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** The trimmed expressions of every {{token}} in a string: "{{ console }}/x/{{vars.id}}" → ["console", "vars.id"]. */
export function listTemplateTokens(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1].trim());
}

/** True when the string contains at least one {{token}}. */
export function hasTokens(text: string): boolean {
  TOKEN.lastIndex = 0;
  const r = TOKEN.test(text);
  TOKEN.lastIndex = 0;
  return r;
}

/** Recursively interpolate every string inside objects/arrays. */
export function interpolateDeep<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === 'string') return interpolate(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateDeep(v, ctx);
    return out as T;
  }
  return value;
}

/**
 * interpolateDeep that knows where it is: a node for which `skip(path, value)` is true stays as written, and a
 * TemplateError names the string that raised it ("scenes[2].steps[3].type.text: unknown template key …").
 * `ctxAt(path)`, when given, picks the context of each string (L1.7: edit text sees the display URLs, steps the real
 * ones); `ctx` otherwise.
 */
export function interpolateAt<T>(
  value: T,
  ctx: TemplateContext,
  path: IssuePath,
  skip?: (path: IssuePath, value: unknown) => boolean,
  ctxAt?: (path: IssuePath) => TemplateContext,
): T {
  if (skip?.(path, value)) return value;
  if (typeof value === 'string') {
    try {
      return interpolate(value, ctxAt ? ctxAt(path) : ctx) as unknown as T;
    } catch (e) {
      if (e instanceof TemplateError && path.length) throw new TemplateError(`${formatPath(path)}: ${e.message}`);
      throw e;
    }
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateAt(v, ctx, [...path, i], skip, ctxAt)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateAt(v, ctx, [...path, k], skip, ctxAt);
    return out as T;
  }
  return value;
}

/** All secret refs (env:/keychain:) used in a value, for prefetching. `note` fields are skipped (never templated). */
export function collectSecretRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN)) {
      const expr = m[1].trim();
      if (/^(env|keychain|secret):/.test(expr)) out.add(expr.startsWith('secret:') ? expr.slice(7) : expr);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectSecretRefs(v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (k !== 'note') collectSecretRefs(v, out);
  }
  return out;
}

/** `accounts.<persona>.password` (a sandbox account's password in a hook): the persona, else undefined. */
const ACCOUNT_PASSWORD = /^accounts\.([^.\s]+)\.password$/;

/**
 * The references a hook resolves from its sandbox (hotfix v0.2.3): `compose_env:NAME` (the compose env file) and
 * `accounts.<persona>.password` (an account's password) — secrets like `env:` / `keychain:` ones (masked; never in a
 * scenario submitted by an agent), kept apart because only the hooks resolve them. `note` fields are skipped.
 */
export function collectSandboxRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN)) {
      const expr = m[1].trim().replace(/\s*\.\s*/g, '.');
      if (expr.startsWith('compose_env:') || ACCOUNT_PASSWORD.test(expr)) out.add(expr);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectSandboxRefs(v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (k !== 'note') collectSandboxRefs(v, out);
  }
  return out;
}

/** Replace every secret value in a string by "***". */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

/**
 * The forms a secret value takes in logs, URLs and DOM snippets, for redaction: as is, URL-encoded (encodeURIComponent,
 * the same with `+` for spaces, encodeURI), as a URL parser serialises it in a path (WHATWG URL in Node; Chrome also
 * encodes `^` and `|` there) and in a query (spaces and `'` encoded, `{|^` kept), as a GET form submits it
 * (URLSearchParams: `!'()~` encoded too), JSON-escaped and HTML-escaped (text and attribute, as outerHTML writes them).
 * None under 3 characters: redact() ignores them (they would mangle every log).
 */
export function secretForms(value: string): string[] {
  if (value.length < 3) return [];
  const forms = [value, JSON.stringify(value).slice(1, -1)];
  try {
    const component = encodeURIComponent(value);
    forms.push(component, component.replace(/%20/g, '+'), encodeURI(value));
    const path = new URL(`http://h/${value}`).href.slice('http://h/'.length);
    forms.push(
      path,
      path.replace(/\^/g, '%5E').replace(/\|/g, '%7C'),
      new URL(`http://h/?${value}`).href.slice('http://h/?'.length),
      new URLSearchParams({ k: value }).toString().slice(2),
    );
  } catch {
    /* a lone surrogate cannot be URL-encoded: it cannot be in a URL either */
  }
  const html = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  forms.push(html, html.replace(/"/g, '&quot;'));
  return [...new Set(forms)];
}

/** Resolve a path (or absolute URL) against an environment page base URL. */
export function resolvePageUrl(base: string, pathOrUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
  if (!base) return pathOrUrl;
  const b = base.endsWith('/') ? base : base + '/';
  const p = pathOrUrl.startsWith('/') ? pathOrUrl.slice(1) : pathOrUrl;
  // keep a base path prefix (https://x/app + /imports → https://x/app/imports)
  return new URL(p, b).toString();
}
