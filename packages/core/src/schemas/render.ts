/**
 * The schemas of a render record (renders/<id>.json). The shapes are written once and built twice: strict objects for
 * what this version writes (`RenderRecordSchema`: a succeeded record, an unknown key is an error), loose ones for what
 * any version — or a person — left on a disk (`StoredRenderRecordSchema`: unknown keys pass at every level, a closed
 * word is any text, a number any number, and the members that decide nothing may be absent).
 *
 * The plan a record holds is opaque here: an object, never looked into (its inside is the renderer's contract). Not in
 * the list of generated JSON schemas: packages/core/schema/ is not this file's business. Their twin types are core
 * render-record.ts's (schemas/type-checks.ts holds them together).
 */
import { z } from 'zod';

/** The object constructor the shapes are built with: `z.strictObject`, or `z.looseObject` under the same type. */
type ObjectOf = typeof z.strictObject;
/**
 * `z.looseObject` typed as the strict constructor: the stored schemas take unknown keys at run time and their types
 * name the known members only (a member this build does not know is never read by name).
 */
const looseObject = z.looseObject as unknown as ObjectOf;

/** A member a state never has: absent (a value there is an error, in the strict and in the loose build). */
const never = () => z.never().optional();

const SOURCES = ['option', 'retake.yaml', 'env', 'default'] as const;

/**
 * The render record's states, built with `object`: `succeeded` (never an error), `failed` and `cancelled` (their
 * error, never a probe), and `unknown`: the same members under a status that is any text. `lax`: the stored build.
 */
function renderRecordSchemas(object: ObjectOf, lax: boolean) {
  // The stored build reads every member that decides nothing leniently: a closed word is any text (kept as the file
  // holds it), a flag any boolean, and the diagnostic blocks, the variant and the plan may be absent. The casts keep
  // the strict build's static types: the type a stored record is read as is core render-record.ts's, which says text
  // where these take text.
  const word = <const T extends readonly [string, ...string[]]>(values: T) => (lax ? (z.string() as unknown as z.ZodEnum<{ [K in T[number]]: K }>) : z.enum(values));
  const flag = () => (lax ? (z.boolean() as unknown as z.ZodLiteral<true>) : z.literal(true));
  const opt = <S extends z.ZodType>(schema: S) => (lax ? (schema.optional() as unknown as S) : schema);
  const base = {
    version: z.literal(1),
    id: z.string(),
    project: z.string(),
    scenario: z.string(),
    run_id: z.string(),
    run_dir: z.string(),
    template: z.string(),
    template_sha256: z.string().optional(),
    template_folder: z.string().optional(),
    overrides: z.record(z.string(), z.unknown()),
    edit: object({
      from: word(['scenario', 'run']),
      sha256: z.string().optional(),
      changes: z.array(z.string()).optional(),
      captions: z.record(z.string(), z.array(z.string())).optional(),
    }).optional(),
    variant: opt(word(['landscape', 'vertical', 'square'])),
    file: z.string(),
    record: z.string(),
    render_version: z.number().optional(),
    created_at: z.string(),
    finished_at: z.string(),
    duration_s: z.number(),
    frames: z.number(),
    fps: z.number(),
    width: z.number(),
    height: z.number(),
    size_bytes: z.number(),
    encoding: opt(
      object({
        codec: word(['h264']),
        encoder: word(['libx264', 'h264_videotoolbox']).optional(),
        crf: z.number().optional(),
        bitrate: z.string().optional(),
        gop: z.number().optional(),
        pixel_format: word(['yuv420p']),
        faststart: flag(),
        audio: word(['silent', 'music', 'files', 'music+files']),
      }),
    ),
    policy: object({
      gl: object({ asked: word(['auto', 'gpu', 'software']), source: word(SOURCES), resolved: word(['angle', 'software']), used: word(['angle', 'software']), renderer: z.string().optional() }),
      encoder: object({ asked: word(['auto', 'videotoolbox', 'libx264']), source: word(SOURCES), used: word(['libx264', 'h264_videotoolbox']) }),
      concurrency_source: word(SOURCES),
      fallback: object({ reason: z.string() }).optional(),
      ffmpeg: object({ asked: word(['auto', 'own', 'library']), source: word(SOURCES), used: word(['own', 'library']), version: z.string().optional(), note: z.string().optional(), failed: z.string().optional() }).optional(),
    }).optional(),
    probe: object({
      duration_s: z.number(),
      frames: z.number().optional(),
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      audio_streams: z.number(),
      video_codec: z.string().optional(),
      audio_codec: z.string().optional(),
    }).optional(),
    concurrency: opt(z.number()),
    bundle: opt(object({ hash: z.string(), cached: z.boolean(), ms: z.number() })),
    browser: opt(object({ path: z.string().nullable(), source: word(['env', 'bundled', 'playwright', 'none', 'remotion']) })),
    timings: opt(object({ plan_ms: z.number(), bundle_ms: z.number(), render_ms: z.number(), total_ms: z.number() })),
    warnings: z.array(z.string()),
    plan: opt(z.record(z.string(), z.unknown())),
  };
  return {
    succeeded: object({ ...base, status: z.literal('succeeded'), error: never() }),
    failed: object({ ...base, status: z.literal('failed'), error: z.string(), probe: never() }),
    cancelled: object({ ...base, status: z.literal('cancelled'), error: z.string(), probe: never() }),
    unknown: object({ ...base, status: z.string(), error: z.string().optional() }),
  };
}

const written = renderRecordSchemas(z.strictObject, false);
const stored = renderRecordSchemas(looseObject, true);

/**
 * renders/<id>.json as this version writes it: a succeeded record — the only state a writer puts on a disk (a failed
 * or cancelled render leaves none) —, unknown keys refused.
 */
export const RenderRecordSchema = written.succeeded;

/** The record a failed or cancelled render carries on its error (never written): its error, never a probe. */
export const RenderAttemptSchema = z.discriminatedUnion('status', [written.failed, written.cancelled]);

/**
 * renders/<id>.json as any version, or a person, left it on a disk: the three states (a failed or cancelled one exists
 * only when written by hand), unknown keys kept at every level (core render-record.ts `parseRenderRecord` is the
 * reader: it repairs what decides nothing before this judges).
 */
export const StoredRenderRecordSchema = z.discriminatedUnion('status', [stored.succeeded, stored.failed, stored.cancelled]);

/** The stored schema of each state, and `unknown`: the same members under a status that is any text (for the reader's lenient pass). */
export const StoredRenderStateSchemas = stored;

/** A stored record whose status is any text: what a record of an unknown status must still hold to be said. */
export const UnknownStatusRenderSchema = stored.unknown;
