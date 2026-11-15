/**
 * The schema of component.yaml: its constants (design spaces, variants, slot sources, theme tokens) and the strict
 * zod schema of the file (unknown keys are errors with a did-you-mean).
 */
import { z } from 'zod';
import { COMPONENT_KINDS, componentIdSchema, keyString } from '@retake/core/model';
import type { ComponentKind } from '@retake/core/model';
import type { ComponentManifest } from './types.js';

export const MANIFEST_FILE = 'component.yaml';
export const DEFAULT_ENTRY = 'index.tsx';

/** Design spaces of layout geometry (and of every size a component draws, before `unit`). */
export const DESIGN_SPACE = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;

/** Output variants (orientations); the manifest key of each one's layout geometry is `GEOMETRY_KEYS` (geometry.ts). */
export const VARIANTS = ['landscape', 'vertical', 'square'] as const;

/** Semantic version (semver.org 2.0.0). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** `engines.kit`: a kit API major, optionally with a caret ("1", "^1"). */
export const KIT_RANGE_RE = /^\^?[1-9]\d{0,2}$/;

/** The kit API major an `engines.kit` value names ("^2" → 2); absent → 1. */
export function kitMajorOf(m: Pick<ComponentManifest, 'engines'>): number {
  const k = m.engines?.kit;
  return k === undefined ? 1 : Number(k.replace(/^\^/, ''));
}

/** Where the planner can take a slot value from when the scenario does not set it (`default_from`). */
export const SLOT_SOURCES = [
  'theme.logo',
  'theme.wordmark',
  'theme.brand.name',
  'theme.brand.url',
  'theme.outro.tagline',
  'theme.outro.url',
  'scenario.title.text',
  'scenario.title.kicker',
  'scenario.outro.tagline',
  'scenario.outro.url',
  'scene.caption.text',
  'scene.caption.kicker',
  'interstitial.text',
  'interstitial.kicker',
] as const;

/** Theme tokens a component may declare in `tokens:` (`colors.<any key>` is accepted too). */
export const THEME_TOKENS = [
  'colors.accent',
  'colors.text',
  'colors.muted',
  'colors.paper',
  'background',
  'fonts.display',
  'fonts.body',
  'logo',
  'wordmark',
  'brand.name',
  'brand.url',
  'cursor.ripple_color',
  'style_bias',
  'captions.kicker',
  'captions.line',
  'brandmark',
  'motion.zoom_ease',
] as const;

/** Kinds a component may declare in `kinds` besides its own: the full-frame kinds and the overlay. */
export const MULTI_USE_KINDS = ['intro', 'outro', 'card', 'interstitial', 'overlay'] as const satisfies readonly ComponentKind[];

/** Kinds whose duration comes from the clip they decorate (a manifest `duration` is ignored). */
export const CLIP_BOUND_KINDS: readonly ComponentKind[] = ['layout', 'caption'];

const nonEmpty = () => z.string().min(1);

export const SlotSpecSchema = z
  .strictObject({
    type: z
      .enum(['text', 'image', 'url', 'color', 'screen', 'email', 'document', 'notification', 'capture', 'frame', 'data', 'media', 'lottie'])
      .describe(
        'text, image (a URL, or an image file of the project), url (shown as text), color (CSS), screen (the capture, ' +
          'layouts only), or data the scenario names: email (a wait_for_email `as`), document (a download `as` or a ' +
          'project file), notification (a captured web notification: its name or 1-based index), capture (a ' +
          'capture_text `as`), frame (a frame of the capture — a mark, start:/end:<scene>, 12.5s — or an image file), ' +
          'data (a CSV / TSV file of the project), media (a video or image file of the project), lottie (a Lottie JSON ' +
          'file of the project) — the component receives it as `props.media[<slot>]`.',
      ),
    description: z.string().describe('What the slot shows (for the UI and Claude).').optional(),
    required: z.boolean().describe('The component cannot render without it (default false).').optional(),
    default_from: nonEmpty()
      .describe(`Where the value comes from when the scenario does not set it: ${SLOT_SOURCES.join(', ')}.`)
      .optional(),
    max_chars: z.number().int().gt(0).describe('Soft length limit (text and url slots), used by validation and review.').optional(),
  })
  .meta({ id: 'SlotSpec', description: 'A value the component renders (title, kicker, logo, url…).' });

/** A geometry value: design px, or an arithmetic expression over the numeric params, `vars` and `aspect`. */
export const GeometryValueSchema = z
  .union([
    z.number(),
    z
      .string()
      .min(1)
      .describe(
        'Expression over the numeric params, the geometry vars and `aspect` (capture width / height): + - * / %, ' +
          'parentheses, min(), max(), round(), floor(), ceil(), abs() — e.g. "round((1920 - width) / 2)".',
      ),
  ])
  .meta({ id: 'GeometryValue', description: 'Design px, or an expression over the params (e.g. "(1920 - width) / 2").' });

export const RectSchema = z
  .strictObject({
    x: GeometryValueSchema.describe('Left, in design px.'),
    y: GeometryValueSchema.describe('Top, in design px.'),
    w: GeometryValueSchema.describe('Width, in design px (> 0).'),
    h: GeometryValueSchema.describe('Height, in design px (> 0).'),
  })
  .meta({ id: 'Rect', description: 'Rectangle in the design space (1920×1080 landscape, 1080×1920 vertical).' });

export const LayoutGeometrySchema = z
  .strictObject({
    vars: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { error: 'a var name is a letter or _ followed by letters, digits or _' }), GeometryValueSchema)
      .describe('Named values computed in order (each may use the params, `aspect` and the vars above it).')
      .optional(),
    screen: RectSchema.describe('Where the capture pixels go (the planner keeps the capture aspect ratio inside it).'),
    frame: RectSchema.describe('Outer shape around the screen (card, device…); defaults to screen.').optional(),
    chrome: RectSchema.describe('Browser chrome bar, when the layout draws one.').optional(),
    caption: RectSchema.describe('Caption area used by the caption component.').optional(),
    brandmark: RectSchema.describe('Brand mark area.').optional(),
    radius: GeometryValueSchema.describe('Corner radius of the screen/frame, in design px (≥ 0).').optional(),
    panes: z
      .array(RectSchema)
      .min(2)
      .max(2)
      .describe('Multi-page layouts (split screen): the screen of each page of a multi-page scene; `screen` is their area. Expressions may use `aspect2` (the second page).')
      .optional(),
    inset: RectSchema.describe("Picture in picture: the second page's screen over `screen` (the first page's) at its default corner; the planner moves it between the corners of `screen`.").optional(),
  })
  .meta({
    id: 'LayoutGeometry',
    description:
      'Layout geometry, so the planner and the review can reason without rendering. Values may be expressions over ' +
      'the params: the planner evaluates them for each use (e.g. a theme width moves the card and the caption rect).',
  });

export const AnchorSchema = z
  .strictObject({
    vars: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { error: 'a var name is a letter or _ followed by letters, digits or _' }), GeometryValueSchema)
      .describe('Named values computed in order.')
      .optional(),
    x: GeometryValueSchema,
    y: GeometryValueSchema,
    w: GeometryValueSchema,
    h: GeometryValueSchema,
  })
  .meta({
    id: 'Anchor',
    description:
      'Where the component draws its tap target (a notification banner, an app icon) at the end of its segment: a transition ' +
      'such as studio/transition-tap-open zooms from it. Expressions may use numeric params, `<param>_<value>` one-hot names ' +
      'of string params (e.g. style_macos), vars and aspect.',
  });

/** The params schema is checked by `checkParamsSchema` (supported JSON Schema subset); zod only wants a mapping. */
export const ParamsJsonSchemaSchema = z.record(z.string(), z.unknown()).describe('JSON Schema (type: object) of the params, with a default for each optional param.');

export const ComponentManifestFileSchema = z
  .strictObject({
    id: componentIdSchema().describe('"namespace/name" — must match the folder <namespace>/<name>/.'),
    version: z
      .string()
      .regex(SEMVER_RE, { error: (iss) => `version must be a semantic version like "1.0.0", got ${JSON.stringify(iss.input)}` })
      .describe('Semantic version (e.g. 1.0.0).'),
    kind: z.enum(COMPONENT_KINDS as [ComponentKind, ...ComponentKind[]]).describe(`What it renders: ${COMPONENT_KINDS.join(', ')}.`),
    kinds: z
      .array(z.enum(MULTI_USE_KINDS as unknown as [ComponentKind, ...ComponentKind[]]))
      .min(1)
      .describe(`Other kinds it can be used as (${MULTI_USE_KINDS.join(', ')}): it reads \`props.as\` to know how it is used.`)
      .optional(),
    name: nonEmpty().describe('Display name.'),
    description: nonEmpty().describe('One or two sentences: what it looks like and when to use it.'),
    publisher: nonEmpty().describe('Publisher (marketplace metadata).').optional(),
    license: nonEmpty().describe('License (SPDX id, marketplace metadata).').optional(),
    tags: z.array(nonEmpty()).describe('Search tags.').optional(),
    entry: nonEmpty().describe(`Implementation file relative to the component folder (default ${DEFAULT_ENTRY}).`).optional(),
    engines: z
      .strictObject({
        kit: z
          .string()
          .regex(KIT_RANGE_RE, { error: (iss) => `engines.kit must be a kit API major such as "1" or "^1", got ${JSON.stringify(iss.input)}` })
          .describe('The kit API major the component was written for: "1" or "^1".'),
      })
      .describe('What the component needs from Retake (absent: kit API 1).')
      .optional(),
    slots: z.record(keyString('slot name'), SlotSpecSchema).describe('Values the component renders, by name (title, kicker, logo…).').optional(),
    params: ParamsJsonSchemaSchema.optional(),
    tokens: z
      .array(nonEmpty())
      .describe(`Theme tokens the component reads: ${THEME_TOKENS.join(', ')}, colors.<key>.`)
      .optional(),
    duration: z
      .strictObject({
        default: z.number().gt(0).describe('Seconds.'),
        min: z.number().gt(0).describe('Seconds.').optional(),
        max: z.number().gt(0).describe('Seconds.').optional(),
      })
      .describe('Seconds on screen (intros, outros, cards, interstitials, overlays, transitions).')
      .optional(),
    geometry: LayoutGeometrySchema.describe('Layouts: geometry in the 1920×1080 design space.').optional(),
    geometry_vertical: LayoutGeometrySchema.describe('Layouts with the vertical variant: geometry in the 1080×1920 design space.').optional(),
    geometry_square: LayoutGeometrySchema.describe('Layouts with the square variant: geometry in the 1080×1080 design space.').optional(),
    anchor: AnchorSchema.describe('Tap target at the end of the segment (1920×1080 design space), for tap-open transitions.').optional(),
    anchor_vertical: AnchorSchema.describe('Tap target in the vertical variant (1080×1920).').optional(),
    anchor_square: AnchorSchema.describe('Tap target in the square variant (1080×1080).').optional(),
    variants: z.array(z.enum(VARIANTS)).min(1).describe('Output orientations the component supports (default [landscape]).').optional(),
    preview: z
      .strictObject({
        slots: z.record(z.string(), z.string()).describe('Sample slot values (every required slot not filled from the theme).').optional(),
        params: z.record(z.string(), z.unknown()).describe('Params of the preview (over the defaults).').optional(),
        at: z.array(z.number().min(0)).min(1).describe('Seconds at which preview stills are taken (the committed preview.png shows the last one).').optional(),
        screen: z.enum(['desktop', 'tablet', 'phone']).describe('Sample screen shown in the preview (layouts, captions, overlays, transitions; default desktop).').optional(),
        screens: z
          .array(z.enum(['desktop', 'tablet', 'phone']))
          .min(2)
          .max(2)
          .describe('Multi-page layouts: the sample screen of each page (e.g. [desktop, phone] for picture in picture).')
          .optional(),
        target: z
          .enum(['button', 'field'])
          .describe("What an overlay preview points at on the sample screen: a button (default) or a text field (its region is the overlay's `screen`, as for a typing loupe).")
          .optional(),
      })
      .describe('Sample values used to render previews with any theme.')
      .optional(),
  })
  .meta({ id: 'ComponentManifest', title: 'Retake component', description: 'component.yaml' });

export type ComponentManifestFile = z.infer<typeof ComponentManifestFileSchema>;
