import { z } from 'zod';

/**
 * A "keyed union" is a union of strict objects told apart by WHICH key is present
 * (`click:` vs `hover:`, `sql:` vs `http:`), not by a discriminator value.
 * Zod reports a failed union as one opaque `invalid_union`; registering the union here lets
 * the issue converter dispatch on the key that is present and report precise messages.
 */
export interface KeyedUnionInfo {
  /** What one entry is called in messages: "step", "hook", "scene". */
  noun: string;
  /** What the discriminating keys are called: "action", "hook type". */
  label: string;
  /** Discriminating keys. */
  keys: readonly string[];
  /** Union branch index for each discriminating key. */
  branchOf: ReadonlyMap<string, number>;
  /** Keys every branch accepts besides its discriminating key. */
  common: readonly string[];
  /** Branch used when no discriminating key is present (absent → "no action" error). */
  fallback?: number;
  /** Short example shown when the entry is not a mapping. */
  example: string;
}

const KEYED = new WeakMap<object, KeyedUnionInfo>();
const EXTRA_KEYS = new WeakMap<object, readonly string[]>();

export function keyedUnionInfo(schema: unknown): KeyedUnionInfo | undefined {
  return typeof schema === 'object' && schema !== null ? KEYED.get(schema) : undefined;
}

/** Extra "did you mean" candidates registered for an object schema (other branches' keys). */
export function extraKeyCandidates(schema: unknown): readonly string[] {
  return (typeof schema === 'object' && schema !== null ? EXTRA_KEYS.get(schema) : undefined) ?? [];
}

export function keyedUnion<const T extends readonly [z.ZodObject, ...z.ZodObject[]]>(
  options: T,
  info: Omit<KeyedUnionInfo, 'branchOf'> & { branchOf?: ReadonlyMap<string, number> },
  meta: z.core.GlobalMeta,
): z.ZodUnion<T> {
  const branchOf = info.branchOf ?? new Map(info.keys.map((k, i) => [k, i] as const));
  const union = z.union(options).meta(meta);
  KEYED.set(union, { ...info, branchOf });
  for (const option of options) EXTRA_KEYS.set(option, info.keys);
  return union;
}
