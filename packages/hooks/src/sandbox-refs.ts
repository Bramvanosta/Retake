/**
 * What a hook reads from the sandbox of its environment (hotfix v0.2.3): `{{compose_env:NAME}}` — a value of the
 * sandbox's compose env file — and `{{accounts.<persona>.username|password}}` — an account of its sandbox.yaml, as its
 * login steps get it. Demo accounts of a local, disposable copy: one source (the sandbox), masked like any secret.
 * Anywhere else than a sandbox environment both are refused with what to write instead.
 */
import { readFile } from 'node:fs/promises';
import { composeEnvRef, envFileValues, listTemplateTokens } from '@retake/core';
import { composeEnvFile, resolveSecretRef } from '@retake/core/io';
import type { LoadedSandbox } from '@retake/core';
import { HookError, errorMessage } from './errors.js';
import type { HookContext } from './types.js';

/** Every {{token}} expression of a JSON-like value, without the spaces around its dots. */
function expressions(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const e of listTemplateTokens(value)) out.add(e.replace(/\s*\.\s*/g, '.'));
  else if (Array.isArray(value)) value.forEach((v) => expressions(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => expressions(v, out));
  return out;
}

/** The sandbox of an environment as loadProject read it (its sandbox.yaml), else undefined. */
function sandboxOf(project: HookContext['project'], env: string): LoadedSandbox | undefined {
  const all = project.sandboxes;
  return all && Object.hasOwn(all, env) ? all[env] : undefined;
}

/** The compose env file of a sandbox, read once per context (a run's setup, teardown and rollbacks share one). */
const envFiles = new WeakMap<HookContext, Map<string, { file: string; values: Record<string, string> }>>();

async function composeEnvOf(ctx: HookContext, env: string, ref: string): Promise<{ file: string; values: Record<string, string> }> {
  let byEnv = envFiles.get(ctx);
  if (!byEnv) envFiles.set(ctx, (byEnv = new Map()));
  const known = byEnv.get(env);
  if (known) return known;
  const sandbox = sandboxOf(ctx.project, env);
  if (!sandbox) {
    throw new HookError(`{{${ref}}} reads a sandbox's compose env file: environment "${env}" is not a sandbox (there, a secret is {{env:VAR}} or {{keychain:service/account}})`);
  }
  const file = composeEnvFile(sandbox);
  if (!file) {
    throw new HookError(`{{${ref}}}: sandbox ${env} has no compose env file (compose.env_file, or a .env next to its first compose file)`);
  }
  let values: Record<string, string>;
  try {
    values = envFileValues(await readFile(file, 'utf8'));
  } catch (e) {
    throw new HookError(`{{${ref}}}: the compose env file ${file} cannot be read: ${errorMessage(e)}`);
  }
  const read = { file, values };
  byEnv.set(env, read);
  return read;
}

/**
 * The `{{compose_env:NAME}}` references of `value`, by name. A name the file does not set (or sets empty) throws. The
 * values are secrets: the caller registers them for redaction (a dry run never prints one).
 */
export async function composeEnvValues(ctx: HookContext, value: unknown, env: string = ctx.env.name): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const expr of expressions(value)) {
    if (!expr.startsWith('compose_env:')) continue;
    const name = expr.slice('compose_env:'.length).trim();
    const { file, values } = await composeEnvOf(ctx, env, expr);
    if (!Object.hasOwn(values, name) || values[name] === '') {
      throw new HookError(`{{${expr}}}: ${name} is not set (or empty) in the compose env file (${file})`);
    }
    out.set(name, values[name]);
  }
  return out;
}

const ACCOUNT_FIELDS = ['username', 'password'] as const;
type AccountField = (typeof ACCOUNT_FIELDS)[number];
const SECRET_REF = /^\{\{\s*((?:env|keychain|secret):[^{}]+?)\s*\}\}$/;

/** The `accounts` roots this module built: never copied into a rollback's snapshot (resolved again when it replays). */
const roots = new WeakSet<object>();

/** Whether a template root is a sandbox's accounts (sandboxAccounts), not a project variable of that name. */
export function isAccountsRoot(v: unknown): boolean {
  return typeof v === 'object' && v !== null && roots.has(v);
}

export interface SandboxAccounts {
  /** `{{accounts.<persona>.<field>}}`: only the fields `value` references. */
  root: Record<string, Partial<Record<AccountField, string>>>;
  /** The values to mask: every password, and a username read from the environment or the keychain. */
  secrets: string[];
}

/**
 * The accounts `value` references as `{{accounts.<persona>.username|password}}`, read from the sandbox.yaml of the
 * environment — a `{{compose_env:NAME}}`, `{{env:VAR}}` or `{{keychain:…}}` one resolved as its login steps get it.
 * Undefined when `value` references none, or when `accounts` is a variable of the project (no sandbox accounts).
 * A dry run resolves nothing secret: a password is "***".
 */
export async function sandboxAccounts(ctx: HookContext, value: unknown, env: string = ctx.env.name): Promise<SandboxAccounts | undefined> {
  const refs = [...expressions(value)].filter((e) => e === 'accounts' || e.startsWith('accounts.'));
  if (!refs.length) return undefined;
  const sandbox = sandboxOf(ctx.project, env);
  const accounts = sandbox?.manifest.accounts;
  if (!accounts || !Object.keys(accounts).length) {
    if (Object.hasOwn({ ...(ctx.project.config.vars ?? {}), ...ctx.vars }, 'accounts')) return undefined;
    throw new HookError(
      `{{${refs[0]}}} reads an account of a sandbox: ${sandbox ? `sandbox ${env} declares no accounts (accounts: in its sandbox.yaml)` : `environment "${env}" is not a sandbox`}`,
    );
  }
  const out: SandboxAccounts = { root: {}, secrets: [] };
  roots.add(out.root);
  for (const expr of refs) {
    const [, persona, field, ...rest] = expr.split('.');
    if (!persona || !ACCOUNT_FIELDS.includes(field as AccountField) || rest.length) {
      throw new HookError(`unknown template key {{${expr}}}: a sandbox account is read as {{accounts.<persona>.username}} or {{accounts.<persona>.password}}`);
    }
    if (!Object.hasOwn(accounts, persona)) {
      throw new HookError(`{{${expr}}}: sandbox ${env} has no account "${persona}" (accounts: ${Object.keys(accounts).join(', ')})`);
    }
    const f = field as AccountField;
    const written = accounts[persona][f];
    if (written === undefined) throw new HookError(`{{${expr}}}: account ${persona} of sandbox ${env} declares no ${f}`);
    let resolved = written;
    let secret = f === 'password';
    const fromFile = composeEnvRef(written);
    const ref = SECRET_REF.exec(written.trim())?.[1];
    if (fromFile !== undefined) {
      const known = sandbox.composeEnv?.[fromFile];
      resolved = known ?? (await composeEnvOf(ctx, env, `compose_env:${fromFile}`)).values[fromFile];
      if (resolved === undefined || resolved === '') throw new HookError(`{{${expr}}}: ${fromFile} is not set (or empty) in the compose env file of sandbox ${env}`);
    } else if (ref !== undefined) {
      secret = true;
      resolved = ctx.dryRun ? '***' : await resolveSecretRef(ref);
    }
    if (secret && ctx.dryRun) resolved = '***';
    else if (secret) out.secrets.push(resolved);
    (out.root[persona] ??= {})[f] = resolved;
  }
  return out;
}
