import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
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

function defaultSecrets(ref: string): string | undefined {
  if (ref.startsWith('env:')) return process.env[ref.slice(4)];
  return undefined;
}

function lookup(expr: string, ctx: TemplateContext): unknown {
  if (/^(env|keychain|secret):/.test(expr)) {
    const ref = expr.startsWith('secret:') ? expr.slice(7) : expr;
    const v = (ctx.secrets ?? defaultSecrets)(ref);
    if (v === undefined) {
      throw new TemplateError(
        ref.startsWith('env:')
          ? `environment variable ${ref.slice(4)} is not set (referenced as {{${expr}}})`
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

/** All secret refs (env:/keychain:) used in a value, for prefetching. */
export function collectSecretRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN)) {
      const expr = m[1].trim();
      if (/^(env|keychain|secret):/.test(expr)) out.add(expr.startsWith('secret:') ? expr.slice(7) : expr);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectSecretRefs(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectSecretRefs(v, out));
  }
  return out;
}

/**
 * Resolve one secret reference:
 *  - env:VAR
 *  - keychain:service/account → macOS `security find-generic-password -s service -a account -w`,
 *    Linux `secret-tool lookup service <service> account <account>`.
 */
export async function resolveSecretRef(ref: string): Promise<string> {
  if (ref.startsWith('secret:')) ref = ref.slice(7);
  if (ref.startsWith('env:')) {
    const v = process.env[ref.slice(4)];
    if (v === undefined) throw new TemplateError(`environment variable ${ref.slice(4)} is not set`);
    return v;
  }
  if (ref.startsWith('keychain:')) {
    const spec = ref.slice('keychain:'.length);
    const slash = spec.indexOf('/');
    const service = slash >= 0 ? spec.slice(0, slash) : spec;
    const account = slash >= 0 ? spec.slice(slash + 1) : '';
    try {
      if (process.platform === 'darwin') {
        const args = ['find-generic-password', '-s', service, '-w'];
        if (account) args.splice(3, 0, '-a', account);
        const { stdout } = await execFileP('security', args);
        return stdout.replace(/\n$/, '');
      }
      const args = ['lookup', 'service', service];
      if (account) args.push('account', account);
      const { stdout } = await execFileP('secret-tool', args);
      return stdout.replace(/\n$/, '');
    } catch (e) {
      throw new TemplateError(`keychain item ${service}${account ? '/' + account : ''} not found: ${(e as Error).message}`);
    }
  }
  throw new TemplateError(`unsupported secret reference "${ref}" (use env:VAR or keychain:service/account)`);
}

/** Resolve every secret ref of `value` and return a synchronous resolver for interpolate(). */
export async function prefetchSecrets(value: unknown): Promise<{ resolver: SecretResolver; values: string[] }> {
  const refs = collectSecretRefs(value);
  const map = new Map<string, string>();
  for (const ref of refs) map.set(ref, await resolveSecretRef(ref));
  return { resolver: (ref) => map.get(ref) ?? defaultSecrets(ref), values: [...map.values()] };
}

/** Replace every secret value in a string by "***". */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
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
