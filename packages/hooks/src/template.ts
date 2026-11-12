import { interpolate, listTemplateTokens } from '@retake/core/base';
import type { TemplateContext } from '@retake/core/base';
import { isAccountsRoot, sandboxAccounts } from './sandbox-refs.js';
import { addSecret, redactDeep, secretResolver } from './secrets.js';
import type { HookContext, TemplateSnapshot } from './types.js';

const SECRET_TOKEN = /^(env|keychain|secret|compose_env):/;

const hasOwn = (o: object | undefined, k: string): boolean => o !== undefined && o !== null && Object.hasOwn(o, k);

/** Every {{token}} expression in the strings of a JSON-like value. */
export function tokensIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(...listTemplateTokens(value));
  else if (Array.isArray(value)) value.forEach((v) => tokensIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => tokensIn(v, out));
  return out;
}

/**
 * Whether the templates of `value` (a hook, or the texts it renders: an sql file, its rollback's, its database URL) use a
 * variable the agent wrote (HookContext.agentVars): `{{vars.x}}`, or a bare `{{x}}` that is not a page.
 */
export function usesAgentVars(value: unknown, ctx: HookContext): boolean {
  const names = new Set(ctx.agentVars ?? []);
  if (!names.size) return false;
  return tokensIn(value).some((expr) => {
    const path = expr.split('.').map((s) => s.trim());
    if (path[0] === 'vars') return path.length > 1 && names.has(path[1]);
    if (path.length === 1 && Object.hasOwn(ctx.env.pages, path[0])) return false;
    return !['hooks', 'run', 'response'].includes(path[0]) && !/^(env|keychain|secret):/.test(expr) && names.has(path[0]);
  });
}

/**
 * `{{accounts.<persona>.username|password}}` of the sandbox of environment `env` (sandbox-refs.ts), as a template
 * root; its secret values are registered for redaction. Undefined: `value` reads none.
 */
async function accountsRoot(ctx: HookContext, value: unknown, env?: string): Promise<Record<string, unknown> | undefined> {
  const accounts = await sandboxAccounts(ctx, value, env);
  if (!accounts) return undefined;
  for (const s of accounts.secrets) addSecret(ctx, s);
  return accounts.root;
}

/**
 * Template context of a hook: environment pages, vars (ctx.vars over project vars), saved hook
 * results, run id and folder, optional extra roots ({{response…}}), the secrets used by `value` and, in a sandbox
 * environment, the accounts it reads (`{{accounts.<persona>.password}}`).
 */
export async function hookTemplateContext(
  ctx: HookContext,
  value: unknown,
  extra?: Record<string, unknown>,
): Promise<TemplateContext> {
  const dry = ctx.dryRun ? drySaved.get(ctx) : undefined;
  const accounts = await accountsRoot(ctx, value);
  return {
    pages: ctx.env.pages,
    vars: { ...(ctx.project.config.vars ?? {}), ...ctx.vars },
    hooks: dry ? { ...ctx.saved, ...dry } : ctx.saved,
    run: ctx.runId ? { id: ctx.runId, ...(ctx.runDir ? { dir: ctx.runDir } : {}) } : undefined,
    extra: accounts ? { ...extra, accounts } : extra,
    secrets: await secretResolver(ctx, value),
  };
}

/** Dry runs: placeholders for the `save_as` results that would exist (ctx.saved itself is left untouched). */
const drySaved = new WeakMap<HookContext, Record<string, unknown>>();

/** Delimits placeholder paths in interpolated text (core JSON-stringifies objects, escaping it as \u0001). */
const MARK = '\u0001';
const MARKED = /"\\u0001([^"\\]*)\\u0001"/g;

/**
 * Any path below it resolves; `render` shows it as "<hooks.name.json.id>". Only used to describe
 * dry runs.
 */
function placeholder(path: string): object {
  return new Proxy(
    {},
    {
      get: (_t, p) => {
        if (p === 'toJSON' || p === 'toString' || p === Symbol.toPrimitive) return () => `${MARK}${path}${MARK}`;
        return typeof p === 'symbol' ? undefined : placeholder(`${path}.${p}`);
      },
      getOwnPropertyDescriptor: (_t, p) =>
        typeof p === 'symbol'
          ? undefined
          : { configurable: true, enumerable: true, writable: true, value: placeholder(`${path}.${p}`) },
      has: () => true,
      ownKeys: () => [],
    },
  );
}

/** Dry run: from now on `{{hooks.<name>…}}` resolves to a placeholder. */
export function addDrySaved(ctx: HookContext, name: string): void {
  let saved = drySaved.get(ctx);
  if (!saved) {
    saved = {};
    drySaved.set(ctx, saved);
  }
  saved[name] = placeholder(`hooks.${name}`);
}

/** core interpolate(), with dry-run placeholders shown as <hooks.name.path>. */
export function render(text: string, tpl: TemplateContext): string {
  const out = interpolate(text, tpl);
  return out.includes('\\u0001') ? out.replace(MARKED, '<$1>') : out;
}

/** core interpolateDeep(), with dry-run placeholders shown as <hooks.name.path>. */
export function renderDeep<T>(value: T, tpl: TemplateContext): T {
  if (typeof value === 'string') return render(value, tpl) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, tpl)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, tpl);
    return out as T;
  }
  return value;
}

/**
 * Template context of a rollback: the captured snapshot plus freshly resolved secrets — and sandbox accounts, read
 * again from the sandbox of the environment the hook ran in (`env`; default: the context's).
 */
export async function snapshotTemplateContext(
  ctx: HookContext,
  snapshot: TemplateSnapshot,
  value: unknown,
  env?: string,
): Promise<TemplateContext> {
  const accounts = await accountsRoot(ctx, value, env);
  return {
    pages: snapshot.pages ?? {},
    vars: snapshot.vars ?? {},
    hooks: snapshot.hooks ?? {},
    run: snapshot.run,
    extra: accounts ? { ...snapshot.extra, accounts } : snapshot.extra,
    secrets: await secretResolver(ctx, value, env),
  };
}

/**
 * Check that every token of `value` resolves now (unknown keys throw core's TemplateError),
 * except tokens whose root is in `later` (e.g. "response", only known after the request).
 */
export function checkTokens(value: unknown, tpl: TemplateContext, later: readonly string[] = []): void {
  for (const expr of tokensIn(value)) {
    if (later.includes(expr.split('.')[0].trim())) continue;
    interpolate(`{{${expr}}}`, tpl);
  }
}

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function put(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = target;
  for (const k of path.slice(0, -1)) {
    const next = cur[k];
    if (next === undefined) cur[k] = {};
    else if (next === null || typeof next !== 'object') return; // an ancestor was captured whole
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value === null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value));
}

/** Mirrors core's lookup order (pages, vars., hooks., run., extra roots, bare vars) for one token. */
function capture(expr: string, tpl: TemplateContext, snap: Record<string, unknown>): void {
  if (SECRET_TOKEN.test(expr)) return;
  const path = expr.split('.').map((s) => s.trim());
  const head = path[0];
  const copy = (root: unknown, rel: string[], prefix: string[]) => {
    const v = getPath(root, rel);
    if (v !== undefined) put(snap, [...prefix, ...rel], v);
  };
  if (path.length === 1 && hasOwn(tpl.pages, head)) return put(snap, ['pages', head], tpl.pages![head]);
  if (head === 'vars') return copy(tpl.vars, path.slice(1), ['vars']);
  if (head === 'hooks') return copy(tpl.hooks, path.slice(1), ['hooks']);
  if (head === 'run') return copy(tpl.run, path.slice(1), ['run']);
  // A sandbox account is a secret reference: left in template form, resolved again when the rollback replays.
  if (head === 'accounts' && isAccountsRoot(tpl.extra?.accounts)) return;
  if (hasOwn(tpl.extra, head)) return copy(tpl.extra![head], path.slice(1), ['extra', head]);
  if (hasOwn(tpl.vars, head)) return copy(tpl.vars, path, ['vars']);
}

/**
 * The non-secret data the tokens of `value` reference, so `value` can be interpolated identically
 * later (another process, after a crash). Secret tokens are skipped; known secret values are redacted.
 */
export function snapshotFor(ctx: HookContext, value: unknown, tpl: TemplateContext): TemplateSnapshot {
  const snap: Record<string, unknown> = {};
  for (const expr of tokensIn(value)) capture(expr, tpl, snap);
  return redactDeep(ctx, snap) as TemplateSnapshot;
}
