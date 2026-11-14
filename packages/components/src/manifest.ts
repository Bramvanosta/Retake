/**
 * component.yaml: the manifest of a component (docs/DESIGN-phase2.md §1.1, SPEC §11).
 *
 * `ComponentManifestFileSchema` is strict (unknown keys are errors with a did-you-mean); `parseManifest` adds the
 * semantic checks (layout geometry inside the design space, duration bounds, slot sources, theme tokens, the params
 * JSON Schema and its defaults, preview samples) and returns positioned issues.
 */
import { z } from 'zod';
import { brokenUnder, checkYamlDocument, didYouMean, hasErrors, locatedIssue } from '@retake/core/base';
import { COMPONENT_KINDS, componentIdSchema, keyString } from '@retake/core/model';
import type { LocatedIssue } from '@retake/core/base';
import type { ComponentKind } from '@retake/core/model';
import { applyParamDefaults, checkParamsSchema, isPlainObject, paramDefaults, validateParamValue } from './json-schema.js';
import { ANCHOR_KEYS, GEOMETRY_BUILTINS, GEOMETRY_KEYS, anchorScope, evalAnchor, evalLayoutGeometry, expressionIdentifiers, geometryIsDynamic, paramEnums } from './geometry.js';
import type { JsonSchemaNode } from './json-schema.js';
import type { AnchorSpec, ComponentIssue, ComponentManifest, LayoutGeometry, LayoutGeometrySpec, Rect1920 } from './types.js';

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

/** `engines.kit` (L4.5): a kit API major, optionally with a caret ("1", "^1"). */
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

/** Kinds a component may declare in `kinds` besides its own (L2.12): the full-frame kinds and the overlay. */
export const MULTI_USE_KINDS = ['intro', 'outro', 'card', 'interstitial', 'overlay'] as const satisfies readonly ComponentKind[];

/** Kinds whose duration comes from the clip they decorate (a manifest `duration` is ignored). */
const CLIP_BOUND_KINDS: readonly ComponentKind[] = ['layout', 'caption'];

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

function rectInside(r: { x: number; y: number; w: number; h: number }, space: { width: number; height: number }): boolean {
  const eps = 1e-6;
  return r.x >= -eps && r.y >= -eps && r.x + r.w <= space.width + eps && r.y + r.h <= space.height + eps;
}

const GEOMETRY_RECTS = ['screen', 'frame', 'chrome', 'caption', 'brandmark'] as const;
type GeometryKey = (typeof GEOMETRY_KEYS)[keyof typeof GEOMETRY_KEYS];
const ALL_GEOMETRY_KEYS = Object.values(GEOMETRY_KEYS) as GeometryKey[];

/**
 * Geometry checks: every expression parses and only names numeric/boolean params, earlier vars or `aspect`; the
 * geometry evaluated with the param defaults (capture aspect 16:9) has positive sizes and stays inside the design
 * space.
 */
function checkGeometry(g: LayoutGeometrySpec, key: GeometryKey, paramTypes: ReadonlyMap<string, string>, out: LocatedIssue[], defaults: Record<string, unknown>): void {
  const space = key === 'geometry' ? DESIGN_SPACE.landscape : key === 'geometry_vertical' ? DESIGN_SPACE.vertical : DESIGN_SPACE.square;
  const known = new Set<string>([...GEOMETRY_BUILTINS, ...[...paramTypes].filter(([, t]) => t === 'number' || t === 'integer' || t === 'boolean').map(([n]) => n)]);
  let syntaxOk = true;
  const check = (path: Array<string | number>, v: unknown) => {
    if (typeof v !== 'string') return;
    let ids: string[];
    try {
      ids = expressionIdentifiers(v);
    } catch (e) {
      syntaxOk = false;
      out.push(locatedIssue('error', [key, ...path], `invalid expression "${v}": ${(e as Error).message}`));
      return;
    }
    for (const id of ids) {
      if (known.has(id)) continue;
      syntaxOk = false;
      const type = paramTypes.get(id);
      const s = didYouMean(id, [...known]);
      out.push(
        locatedIssue(
          'error',
          [key, ...path],
          type
            ? `"${id}" is a ${type} param: expressions only use number, integer or boolean params`
            : `unknown name "${id}" in "${v}"${s ? ` (did you mean "${s}"?)` : ''}; known: ${[...known].join(', ')}`,
        ),
      );
    }
  };
  for (const [name, v] of Object.entries(g.vars ?? {})) {
    check(['vars', name], v);
    if (name === 'aspect' || name === 'aspect2') {
      syntaxOk = false;
      out.push(locatedIssue('error', [key, 'vars', name], `"${name}" is built in (the ${name === 'aspect' ? 'capture' : 'second page'}'s width / height)`));
    } else if (paramTypes.has(name)) {
      // A var may not shadow a param (it would silently change what the name means).
      syntaxOk = false;
      out.push(locatedIssue('error', [key, 'vars', name], `var "${name}" has the name of a param`));
    }
    known.add(name);
  }
  for (const name of GEOMETRY_RECTS) {
    const r = g[name];
    if (r) for (const k of ['x', 'y', 'w', 'h'] as const) check([name, k], r[k]);
  }
  check(['radius'], g.radius);
  (g.panes ?? []).forEach((r, i) => {
    for (const k of ['x', 'y', 'w', 'h'] as const) check(['panes', i, k], r[k]);
  });
  if (g.inset) for (const k of ['x', 'y', 'w', 'h'] as const) check(['inset', k], g.inset[k]);
  if (g.panes && g.inset) {
    syntaxOk = false;
    out.push(locatedIssue('error', [key, 'inset'], 'a layout shows its pages side by side (`panes`) or one over the other (`inset`), not both'));
  }
  if (!syntaxOk) return;
  let e: LayoutGeometry;
  try {
    e = evalLayoutGeometry(g, defaults);
  } catch (err) {
    out.push(locatedIssue('error', [key], `the geometry cannot be evaluated with the param defaults: ${(err as Error).message}`));
    return;
  }
  const dynamic = geometryIsDynamic(g);
  const withDefaults = dynamic ? ' (with the param defaults, capture 16:9)' : '';
  for (const name of GEOMETRY_RECTS) {
    const r = e[name];
    if (!r) continue;
    let sized = true;
    for (const k of ['w', 'h'] as const) {
      if (r[k] <= 0) {
        sized = false;
        out.push(locatedIssue('error', [key, name, k], `must be > 0${typeof g[name]?.[k] === 'string' ? `, is ${r[k]}${withDefaults}` : ''}`));
      }
    }
    if (sized && !rectInside(r, space)) {
      out.push(locatedIssue('error', [key, name], `${name} rect {x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h}}${withDefaults} leaves the ${space.width}×${space.height} design space`));
    }
  }
  if (e.radius !== undefined && e.radius < 0) out.push(locatedIssue('error', [key, 'radius'], `must be ≥ 0, is ${e.radius}${withDefaults}`));
  const extra: Array<{ path: Array<string | number>; r: Rect1920 }> = [...(e.panes ?? []).map((r, i) => ({ path: ['panes', i], r })), ...(e.inset ? [{ path: ['inset'], r: e.inset }] : [])];
  for (const { path, r } of extra) {
    if (r.w <= 0 || r.h <= 0) out.push(locatedIssue('error', [key, ...path], `must have a size > 0, is ${r.w}×${r.h}${withDefaults}`));
    else if (!rectInside(r, space))
      out.push(locatedIssue('error', [key, ...path], `rect {x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h}}${withDefaults} leaves the ${space.width}×${space.height} design space`));
  }
}

/** An anchor's expressions only name numeric params, one-hot string values, vars and aspect; with the defaults it lies in the design space. */
function checkAnchor(spec: AnchorSpec, key: string, variant: 'landscape' | 'vertical' | 'square', schema: JsonSchemaNode | undefined): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  const enums = paramEnums(schema);
  const defaults = schema ? paramDefaults(schema) : {};
  const frame = DESIGN_SPACE[variant];
  const known = new Set<string>(Object.keys(anchorScope(defaults, { enums, frame: { w: frame.width, h: frame.height } })));
  if (schema && isPlainObject(schema.properties)) {
    for (const [name, sch] of Object.entries(schema.properties as Record<string, unknown>)) {
      const t = isPlainObject(sch) ? sch.type : undefined;
      if (t === 'number' || t === 'integer' || t === 'boolean') known.add(name);
    }
  }
  let ok = true;
  const check = (path: Array<string | number>, v: unknown) => {
    if (typeof v !== 'string') return;
    let ids: string[];
    try {
      ids = expressionIdentifiers(v);
    } catch (e) {
      ok = false;
      out.push(locatedIssue('error', [key, ...path], `invalid expression "${v}": ${(e as Error).message}`));
      return;
    }
    for (const id of ids) {
      if (known.has(id)) continue;
      ok = false;
      const s = didYouMean(id, [...known]);
      out.push(locatedIssue('error', [key, ...path], `unknown name "${id}" in "${v}"${s ? ` (did you mean "${s}"?)` : ''}`));
    }
  };
  for (const [name, v] of Object.entries(spec.vars ?? {})) {
    check(['vars', name], v);
    known.add(name);
  }
  for (const k of ['x', 'y', 'w', 'h'] as const) check([k], spec[k]);
  if (!ok) return out;
  try {
    const r = evalAnchor(spec, defaults, { enums, frame: { w: frame.width, h: frame.height } });
    const space = frame;
    if (r.w < 0 || r.h < 0) out.push(locatedIssue('error', [key], 'w and h must be ≥ 0 (with the param defaults)'));
    else if (!rectInside(r, space))
      out.push(locatedIssue('error', [key], `anchor {x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h}} leaves the ${space.width}×${space.height} design space (param defaults)`));
  } catch (e) {
    out.push(locatedIssue('error', [key], `the anchor cannot be evaluated with the param defaults: ${(e as Error).message}`));
  }
  return out;
}

/** Semantic checks of a structurally valid manifest. Exported for tests; use `parseManifest`. */
export function checkManifest(value: unknown, structural: readonly LocatedIssue[]): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  if (!isPlainObject(value)) return out;
  const m = value as Partial<ComponentManifestFile>;
  const ok = (path: Array<string | number>) => !brokenUnder(structural, path);
  const kind = ok(['kind']) ? m.kind : undefined;
  const slots = ok(['slots']) && isPlainObject(m.slots) ? m.slots : {};

  // Slots: sources and limits.
  for (const [name, slot] of Object.entries(slots)) {
    if (!ok(['slots', name]) || !isPlainObject(slot)) continue;
    if (slot.default_from !== undefined && !(SLOT_SOURCES as readonly string[]).includes(slot.default_from)) {
      const s = didYouMean(slot.default_from, SLOT_SOURCES);
      out.push(locatedIssue('warning', ['slots', name, 'default_from'], `unknown slot source "${slot.default_from}"${s ? ` (did you mean "${s}"?)` : ''}; known: ${SLOT_SOURCES.join(', ')}`));
    }
    if (slot.max_chars !== undefined && slot.type !== 'text' && slot.type !== 'url') {
      out.push(locatedIssue('warning', ['slots', name, 'max_chars'], `max_chars only applies to text and url slots ("${name}" is ${slot.type})`));
    }
    if (slot.type === 'screen' && kind !== undefined && kind !== 'layout' && kind !== 'interstitial' && kind !== 'transition') {
      out.push(locatedIssue('warning', ['slots', name, 'type'], `screen slots are filled for layouts, interstitials and transitions only, not for ${kind} components`));
    }
  }

  // Other kinds (L2.12).
  if (Array.isArray(m.kinds) && ok(['kinds'])) {
    m.kinds.forEach((k, i) => {
      if (k === kind) out.push(locatedIssue('warning', ['kinds', i], `"${k}" is the component's own kind: no need to list it in kinds`));
      else if (m.kinds!.indexOf(k) !== i) out.push(locatedIssue('error', ['kinds', i], `"${k}" is listed twice`));
    });
    if (kind !== undefined && !(MULTI_USE_KINDS as readonly string[]).includes(kind)) {
      out.push(locatedIssue('error', ['kinds'], `only ${MULTI_USE_KINDS.join(', ')} components may be used as other kinds (this one is ${kind})`, { path: ['kinds'], key: true }));
    }
  }

  // Layout geometry.
  if (kind === 'layout') {
    if (m.geometry === undefined) {
      out.push(
        locatedIssue('error', [], 'a layout component must declare "geometry" (screen rect, + caption/brandmark… in the 1920×1080 design space)', {
          path: ['kind'],
        }),
      );
    }
    for (const variant of ['vertical', 'square'] as const) {
      const declared = ok(['variants']) && Array.isArray(m.variants) && m.variants.includes(variant);
      const key = GEOMETRY_KEYS[variant];
      if (declared && m[key] === undefined) {
        const space = DESIGN_SPACE[variant];
        out.push(
          locatedIssue('error', [], `a layout with the ${variant} variant must declare "${key}" (${space.width}×${space.height} design space)`, {
            path: ['variants'],
          }),
        );
      }
    }
  } else if (kind !== undefined) {
    for (const key of ALL_GEOMETRY_KEYS) {
      if (m[key] !== undefined) out.push(locatedIssue('warning', [key], `${key} is only used by layout components (this one is ${kind})`, { path: [key], key: true }));
    }
  }
  if (ALL_GEOMETRY_KEYS.some((key) => m[key] !== undefined)) {
    const paramTypes = new Map<string, string>();
    let defaults: Record<string, unknown> = {};
    if (m.params !== undefined && ok(['params']) && !hasErrors(checkParamsSchema(m.params, ['params']))) {
      const props = isPlainObject((m.params as JsonSchemaNode).properties) ? ((m.params as JsonSchemaNode).properties as Record<string, unknown>) : {};
      for (const [name, sch] of Object.entries(props)) {
        const t = isPlainObject(sch) ? sch.type : undefined;
        paramTypes.set(name, typeof t === 'string' ? t : Array.isArray(t) ? t.join('|') : 'value');
      }
      defaults = paramDefaults(m.params as JsonSchemaNode);
    }
    for (const key of ALL_GEOMETRY_KEYS) {
      if (m[key] !== undefined && ok([key])) checkGeometry(m[key] as LayoutGeometrySpec, key, paramTypes, out, defaults);
    }
  }

  // Anchors (tap targets for tap-open transitions).
  for (const variant of ['landscape', 'vertical', 'square'] as const) {
    const key = ANCHOR_KEYS[variant];
    const spec = m[key] as AnchorSpec | undefined;
    if (spec === undefined || !ok([key])) continue;
    const schema = m.params !== undefined && ok(['params']) && !hasErrors(checkParamsSchema(m.params, ['params'])) ? (m.params as JsonSchemaNode) : undefined;
    out.push(...checkAnchor(spec, key, variant, schema));
  }

  // Duration.
  if (m.duration !== undefined && ok(['duration'])) {
    const d = m.duration;
    if (d.min !== undefined && d.max !== undefined && d.min > d.max) {
      out.push(locatedIssue('error', ['duration', 'min'], `min (${d.min} s) is greater than max (${d.max} s)`));
    } else {
      if (d.min !== undefined && d.default < d.min) out.push(locatedIssue('error', ['duration', 'default'], `default (${d.default} s) is below min (${d.min} s)`));
      if (d.max !== undefined && d.default > d.max) out.push(locatedIssue('error', ['duration', 'default'], `default (${d.default} s) is above max (${d.max} s)`));
    }
    if (kind !== undefined && CLIP_BOUND_KINDS.includes(kind)) {
      out.push(locatedIssue('warning', ['duration'], `duration is ignored for ${kind} components (they last as long as their clip)`, { path: ['duration'], key: true }));
    }
  }

  // Variants.
  if (Array.isArray(m.variants) && ok(['variants'])) {
    m.variants.forEach((v, i) => {
      if (m.variants!.indexOf(v) !== i) out.push(locatedIssue('error', ['variants', i], `"${v}" is listed twice`));
    });
  }

  // Theme tokens.
  if (Array.isArray(m.tokens) && ok(['tokens'])) {
    m.tokens.forEach((t, i) => {
      if ((THEME_TOKENS as readonly string[]).includes(t) || /^colors\.[A-Za-z0-9_-]+$/.test(t)) return;
      const s = didYouMean(t, THEME_TOKENS);
      out.push(locatedIssue('warning', ['tokens', i], `unknown theme token "${t}"${s ? ` (did you mean "${s}"?)` : ''}`));
    });
  }

  // Entry file.
  if (typeof m.entry === 'string' && ok(['entry'])) {
    const e = m.entry.replace(/\\/g, '/');
    if (e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.split('/').includes('..')) {
      out.push(locatedIssue('error', ['entry'], `entry must be a path inside the component folder, got "${m.entry}"`));
    } else if (!/\.(tsx|ts|jsx|js)$/.test(e)) {
      out.push(locatedIssue('error', ['entry'], `entry must be a .tsx, .ts, .jsx or .js file, got "${m.entry}"`));
    }
  }

  // Params JSON Schema, then the preview samples.
  let paramsSchema: JsonSchemaNode | undefined;
  if (m.params !== undefined && ok(['params'])) {
    const issues = checkParamsSchema(m.params, ['params']);
    out.push(...issues);
    if (!hasErrors(issues)) paramsSchema = m.params as JsonSchemaNode;
  }
  const preview = ok(['preview']) && isPlainObject(m.preview) ? m.preview : undefined;
  const previewSlots = preview && isPlainObject(preview.slots) ? preview.slots : {};
  for (const name of Object.keys(previewSlots)) {
    if (slots[name] !== undefined || !ok(['slots'])) continue;
    const s = didYouMean(
      name,
      Object.keys(slots).filter((k) => previewSlots[k] === undefined),
    );
    out.push(
      locatedIssue('error', ['preview', 'slots'], `unknown slot "${name}"${s ? ` (did you mean "${s}"?)` : ''}: declare it under slots`, {
        path: ['preview', 'slots', name],
        key: true,
      }),
    );
  }
  if (ok(['slots'])) {
    const missing = Object.entries(slots)
      .filter(([name, slot]) => slot.required === true && slot.type !== 'screen' && !slot.default_from?.startsWith('theme.') && previewSlots[name] === undefined)
      .map(([name]) => name);
    if (missing.length > 0) {
      out.push(
        locatedIssue(
          'error',
          preview ? ['preview'] : [],
          `preview.slots must give a sample for the required slot${missing.length > 1 ? 's' : ''} ${missing.map((n) => `"${n}"`).join(', ')} ` +
            '(previews render with any theme but without a scenario)',
          preview ? { path: ['preview'], key: true } : undefined,
        ),
      );
    }
  }
  if (preview && preview.params !== undefined && (m.params === undefined || paramsSchema !== undefined)) {
    const schema = paramsSchema ?? { type: 'object', properties: {} };
    const merged = applyParamDefaults(schema, preview.params as Record<string, unknown>);
    out.push(...validateParamValue(schema, merged, ['preview', 'params']));
  }
  return out;
}

/** The manifest with its defaults applied (entry, slots). */
export function normalizeManifest(file: ComponentManifestFile): ComponentManifest {
  const out = { ...structuredClone(file), entry: file.entry ?? DEFAULT_ENTRY, slots: structuredClone(file.slots ?? {}) } as ComponentManifest;
  return out;
}

export interface ParseManifestOptions {
  /** "<namespace>/<name>" of the folder holding the file: the manifest id must equal it. */
  folderId?: string;
}

export interface ParsedManifest {
  /** Set when there is no error-level issue. */
  manifest?: ComponentManifest;
  issues: ComponentIssue[];
}

/**
 * Parse and validate component.yaml text. Issues carry line/col and `file` (the name given, default
 * "component.yaml"); `manifest` is returned only when there is no error.
 */
export function parseManifest(text: string, file: string = MANIFEST_FILE, opts: ParseManifestOptions = {}): ParsedManifest {
  const semantic = (value: unknown, structural: readonly LocatedIssue[]): LocatedIssue[] => {
    const out = checkManifest(value, structural);
    const id = isPlainObject(value) ? value.id : undefined;
    if (opts.folderId !== undefined && typeof id === 'string' && !brokenUnder(structural, ['id']) && id !== opts.folderId) {
      out.push(
        locatedIssue(
          'error',
          ['id'],
          `id "${id}" does not match the folder path "${opts.folderId}": a component lives in <components>/<namespace>/<name>/ — ` + `rename the folder or set id: ${opts.folderId}`,
        ),
      );
    }
    return out;
  };
  const { value, issues } = checkYamlDocument(text, ComponentManifestFileSchema, semantic);
  const withFile = issues.map((i) => ({ ...i, file }));
  if (hasErrors(issues)) return { issues: withFile };
  return { manifest: normalizeManifest(value as ComponentManifestFile), issues: withFile };
}
