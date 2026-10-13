import { collectSecretRefs, redact, resolveSecretRef, secretForms } from '@demo-studio/core';
import type { SecretResolver } from '@demo-studio/core';
import type { HookContext, HookLogLevel } from './types.js';
import { isRecord } from './util.js';

/** Secret values resolved for a context (shared by setup, teardown and rollbacks run with the same ctx). */
const registry = new WeakMap<HookContext, Set<string>>();

function secretSet(ctx: HookContext): Set<string> {
  let set = registry.get(ctx);
  if (!set) {
    set = new Set();
    registry.set(ctx, set);
  }
  return set;
}

/** Register a secret value (and its URL-encoded / JSON-escaped / HTML-escaped forms, core secretForms) for redaction. */
export function addSecret(ctx: HookContext, value: string): void {
  const set = secretSet(ctx);
  for (const form of secretForms(value)) set.add(form);
}

/** Replace every known secret value by "***" (longest first, so overlapping secrets are fully masked). */
export function redactText(ctx: HookContext, text: string): string {
  const set = registry.get(ctx);
  if (!set?.size) return text;
  return redact(text, [...set].sort((a, b) => b.length - a.length));
}

/** Redact every string inside a JSON-like value. */
export function redactDeep<T>(ctx: HookContext, value: T): T {
  if (typeof value === 'string') return redactText(ctx, value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(ctx, v)) as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(ctx, v);
    return out as T;
  }
  return value;
}

/** ctx.log with redaction. */
export function logger(ctx: HookContext): (level: HookLogLevel, msg: string) => void {
  return (level, msg) => ctx.log(level, redactText(ctx, msg));
}

/** Resolved secret refs per context, so a keychain item is looked up once per run. */
const resolved = new WeakMap<HookContext, Map<string, string>>();

/**
 * A synchronous resolver for every secret reference used in `value`. Real runs resolve them
 * (env / keychain, cached per context) and register the values for redaction; dry runs only check
 * that env variables exist and substitute "***" (no keychain access).
 */
export async function secretResolver(ctx: HookContext, value: unknown): Promise<SecretResolver> {
  if (ctx.dryRun) {
    return (ref) => (ref.startsWith('env:') && process.env[ref.slice(4)] === undefined ? undefined : '***');
  }
  let known = resolved.get(ctx);
  if (!known) {
    known = new Map();
    resolved.set(ctx, known);
  }
  for (const ref of collectSecretRefs(value)) {
    if (known.has(ref)) continue;
    const v = await resolveSecretRef(ref);
    known.set(ref, v);
    addSecret(ctx, v);
  }
  const cache = known;
  return (ref) => {
    const v = cache.get(ref) ?? (ref.startsWith('env:') ? process.env[ref.slice(4)] : undefined);
    if (v !== undefined) addSecret(ctx, v);
    return v;
  };
}
