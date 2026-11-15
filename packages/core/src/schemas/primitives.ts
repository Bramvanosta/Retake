import { z } from 'zod';
import { COMPONENT_KINDS, MEDIA_FITS } from '../types/model.js';
import type { BBox, ComponentRef, MediaFit, PointSpec } from '../types/model.js';

/** Scene / step / marker ids: used in refs ("scene.step"), file names and CLI flags. */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Names usable as template keys ({{name}}, {{hooks.name.json}}): no dots, no spaces. */
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function slugString(what: string) {
  return z.string().regex(SLUG_RE, {
    error: `${what} must be slug-like: letters, digits, "-" or "_", starting with a letter or digit`,
  });
}

export function keyString(what: string) {
  return z.string().regex(KEY_RE, {
    error: `${what} must be an identifier: letters, digits, "_" or "-", starting with a letter or "_"`,
  });
}

export const nonEmpty = () => z.string().min(1);
/**
 * `version:` of a file whose format version is optional (R-PRIN-13: scenarios, project.yaml, template.yaml, retake.yaml,
 * run.json): 1, or absent (read as 1). A higher one is refused before the schema (core formats.ts).
 */
export const fileVersion = () => z.literal(1).describe("Version of this file's format (1). Optional: a file without it is version 1.").optional();
export const seconds = () => z.number().min(0);
export const positiveSeconds = () => z.number().gt(0);
export const millis = () => z.number().min(0);

export const PointSchema: z.ZodType<PointSpec> = z
  .strictObject({
    x: z.number().describe('Viewport x in CSS px.'),
    y: z.number().describe('Viewport y in CSS px.'),
  })
  .meta({ id: 'Point', description: 'Absolute viewport point in CSS px.' });

export const BBoxSchema: z.ZodType<BBox> = z
  .strictObject({ x: z.number(), y: z.number(), w: z.number().min(0), h: z.number().min(0) })
  .meta({ id: 'BBox', description: 'Box in CSS px of the captured viewport.' });

/** Component ids: "namespace/name", lower-case letters, digits and "-" on each side. */
export const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

export const COMPONENT_ID_RULE = 'lower-case letters, digits and "-", e.g. "studio/intro-stack"';

/** A component id ("namespace/name"); `what` names the field in the message ("layout component id"…). */
export function componentIdSchema(what = 'component id') {
  return z.string().regex(COMPONENT_ID_RE, {
    error: (iss) => `${what} must be "namespace/name" (${COMPONENT_ID_RULE}), got ${JSON.stringify(iss.input)}`,
  });
}

export const ComponentKindSchema = z.enum(COMPONENT_KINDS as [string, ...string[]]);

export const ComponentParamsSchema = z.record(z.string(), z.unknown()).describe("Component params (see the component's params schema; unset params take its defaults).");

export const ComponentRefSchema: z.ZodType<ComponentRef> = z
  .union([
    componentIdSchema(),
    z.strictObject({
      id: componentIdSchema().describe('Component id "namespace/name".'),
      params: ComponentParamsSchema.optional(),
    }),
  ])
  .meta({
    id: 'ComponentRef',
    description: 'A component id "namespace/name" (e.g. studio/intro-stack), or {id, params}.',
  });

// ── User media (L2.12) ───────────────────────────────────────────────────────

/**
 * The fields of a user file (video, image or Lottie) on an intro, an outro, a card, an interstitial — and, without
 * `background`, on a step overlay. Which of them apply to which file is checked semantically (positioned errors).
 */
export const mediaFileShape = {
  video: nonEmpty().describe('A video file of the project (.mp4, .mov, .webm, .m4v — H.264, HEVC, VP8, VP9, AV1 or ProRes) shown instead of a component; its own sound is kept.').optional(),
  image: nonEmpty().describe('An image file of the project (.png, .jpg, .jpeg, .webp, .svg) shown instead of a component.').optional(),
  lottie: nonEmpty().describe('A Lottie animation of the project (bodymovin .json) played by studio/lottie instead of a component.').optional(),
  from: z.number().min(0).describe('Video: the second of the file the part shown starts at (default 0).').optional(),
  to: z.number().gt(0).describe("Video: the second of the file the part shown ends at (default: the file's end).").optional(),
  fit: z
    .enum(MEDIA_FITS as [MediaFit, ...MediaFit[]])
    .describe("cover (fills, cropped) or contain (whole). Default: an overlay contains; a segment covers when the file has about the frame's shape, else contains.")
    .optional(),
  background: nonEmpty().describe('Around a contained or transparent file: theme (the theme background, default), a theme colour key (paper, dark, accent…), a CSS colour or none.').optional(),
  volume: z.number().min(0).max(1).describe("Video: volume of the file's own sound, 0–1 (default 1).").optional(),
};

/** Slot values of a component use (title, kicker, text…). */
export const SlotsSchema = z.record(keyString('slot name'), z.string()).describe('Slot values (title, kicker, text…) as the component declares them.');
