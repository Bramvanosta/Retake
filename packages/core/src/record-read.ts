/**
 * What the parsers of the two records share (core run-record.ts and render-record.ts): the lenient read of the members
 * that decide nothing, and the small tests around it. Each parser hands its own two tables — which members decide what
 * a record is (never repaired), and the empty value of the members every record holds.
 *
 * Pure: no I/O. Not in an index on purpose: it is imported by path from the two parsers only — a third reader of a
 * record would be a second parse boundary.
 */
import { z } from 'zod';

/** A member that did not read and was left out (or replaced by its empty value): its path, then `-dropped`. */
type Note = `${string}-dropped`;

/** The two tables of a record's lenient read. */
export interface LenientTables {
  /** The members (of the root) that decide what a record is: never repaired — a record without them, or with a wrong one, is no record. */
  deciding: ReadonlySet<string>;
  /** The empty value of a member every record holds, by its path: what it is read as when the file's does not read. */
  empty: Readonly<Record<string, () => unknown>>;
}

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The path of the first issue of a schema's refusal (a path, never a value), `(root)` for the value itself. */
export const firstPath = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string => issues[0]?.path.map(String).join('.') || '(root)';

/**
 * The value the schema accepted, as the file held it: the schemas judge and change nothing (no default, no transform),
 * so what was read is what the file says, its members in the file's order. `T` is the type the record is read as, which
 * says text where the stored schemas take text.
 */
export function asRead<T>(value: Record<string, unknown>): T {
  return value as T;
}

const unwrapped = (schema: z.ZodType): z.ZodType => (schema instanceof z.ZodOptional ? unwrapped(schema.unwrap() as z.ZodType) : schema);

/**
 * `value` with every member of `shape` that does not read repaired: an object is read member by member; a member a
 * record may lack is left out; one every record holds becomes its empty value (`tables.empty`). Undefined (inside a
 * block only): a member that must be there has no empty value, so the block does not read. A member a state never has
 * is not touched: its presence is what makes the record impossible. `value` itself is never changed, and is answered
 * as it is when everything reads.
 */
export function lenient(value: Record<string, unknown>, shape: Readonly<Record<string, z.ZodType>>, path: string, notes: Note[], tables: LenientTables): Record<string, unknown> | undefined {
  let out = value;
  for (const [key, schema] of Object.entries(shape)) {
    const at = `${path}${key}`;
    const inner = unwrapped(schema);
    if ((path === '' && tables.deciding.has(key)) || inner instanceof z.ZodNever) continue;
    const held = out[key];
    if (schema.safeParse(held).success) continue;
    let next: unknown;
    const from = isObj(held) ? held : undefined;
    if (inner instanceof z.ZodObject && (from !== undefined || at in tables.empty)) next = lenient(from ?? {}, inner.shape as Record<string, z.ZodType>, `${at}.`, notes, tables);
    else next = tables.empty[at]?.();
    if (next === undefined && !schema.safeParse(undefined).success) {
      // A member that must be there and has no empty value. Inside a block: the block does not read (the caller
      // leaves it out). At the root: left as it is, for the schema to refuse the record at this member — the other
      // members are still repaired, so the refusal names what decides, never a member that decides nothing.
      if (path !== '') return undefined;
      continue;
    }
    // An object read member by member says which of its members were left out; anything else says itself.
    if (held !== undefined && !(isObj(next) && from !== undefined)) notes.push(`${at}-dropped`);
    out = { ...out };
    if (next === undefined) delete out[key];
    else out[key] = next;
  }
  return out;
}
