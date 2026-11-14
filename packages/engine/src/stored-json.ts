/**
 * The parse boundary of the engine's own stored formats (job records and events, history and journal lines, the worker
 * lock, filming markers, a theme's provenance, an inspection's report, the live channel, the Studio's token record…):
 * a file's text is JSON and its schema accepts it, or it is not one. Each format has one reader, in the file that writes
 * it, which hands this its schema and answers the format's type; the `record-read` check (scripts/audit) counts a
 * `JSON.parse` typed as one of those formats anywhere else.
 *
 * The schemas judge and change nothing (no default, no transform; unknown members pass through): what was read is what
 * the file says. Each reader decides what a refused text is — skipped like a torn line, or a clear error.
 */
import type { z } from 'zod';

/** `text` as JSON that `schema` accepts, else undefined (not JSON, or refused). */
export function storedJson(schema: z.ZodType, text: string): unknown {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = schema.safeParse(v);
  return r.success ? v : undefined;
}
