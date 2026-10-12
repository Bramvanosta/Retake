import { z } from 'zod';
import { COMPONENT_KINDS } from '../types.js';
import type {
  BBox,
  CameraHint,
  CaptionSpec,
  ComponentRef,
  EaseSpec,
  FrameSpec,
  FrameStyle,
  PointSpec,
  ScopeSpec,
  SceneTransition,
  TargetSpec,
  TutorialSwitch,
} from '../types.js';
import { suggestion } from '../validation/suggest.js';

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

/** Fields of a target object; spread into click/hover args that mix target + options. */
export const targetShape = {
  text: nonEmpty()
    .describe('Visible text, whitespace-normalised. Exact match first, then case-insensitive substring (unless `exact`).')
    .optional(),
  contains: z
    .union([nonEmpty(), z.array(nonEmpty()).min(1)])
    .describe('Element whose text contains ALL these strings; the innermost such element wins.')
    .optional(),
  role: nonEmpty()
    .describe('ARIA role (explicit or implicit): button, link, textbox, combobox, checkbox, option, menuitem, row, dialog, tab…')
    .optional(),
  name: nonEmpty().describe('Accessible name, used together with `role`.').optional(),
  label: nonEmpty().describe('Form control whose label text matches.').optional(),
  aria: nonEmpty().describe('aria-label value (exact first, then substring).').optional(),
  placeholder: nonEmpty().describe('placeholder attribute.').optional(),
  css: nonEmpty().describe('Raw CSS selector.').optional(),
  testid: nonEmpty().describe('data-testid value.').optional(),
  in: z
    .lazy((): z.ZodType<ScopeSpec> => ScopeSpecSchema)
    .describe('Restrict the search to a scope: dialog, menu, listbox, popover, page, {row: "text"} or a target.')
    .optional(),
  nth: z.number().int().describe('0-based index among visible matches (negative = from the end).').optional(),
  last_visible: z.boolean().describe('Pick the LAST visible match (e.g. the most recently mounted popover).').optional(),
  exact: z.boolean().describe('Disable the substring fallback of text/name/aria/label.').optional(),
};

export const TargetObjectSchema = z.strictObject(targetShape).meta({
  id: 'TargetObject',
  description: 'Element locator. Combine keys to narrow the match (e.g. {text: Save, in: dialog}).',
});

export const TargetSpecSchema: z.ZodType<TargetSpec> = z.union([nonEmpty(), TargetObjectSchema]).meta({
  id: 'TargetSpec',
  description:
    'Visible text ("Save"), a CSS selector string ("#id", ".class", "[attr]", "a > b") or a target object.',
});

export const ScopeSpecSchema: z.ZodType<ScopeSpec> = z
  .union([
    z.enum(['dialog', 'menu', 'listbox', 'popover', 'page']),
    z.strictObject({ row: nonEmpty().describe('Text contained in the row.') }),
    TargetObjectSchema,
  ])
  .meta({
    id: 'ScopeSpec',
    description:
      'Scope keyword (topmost visible dialog/menu/listbox/popover, or the whole page), {row: "text"} or a target object.',
  });

export const CaptionSpecSchema: z.ZodType<CaptionSpec> = z
  .union([
    nonEmpty(),
    z.strictObject({
      kicker: z.string().describe('Small line above the caption.').optional(),
      text: nonEmpty().describe('Caption line.'),
    }),
  ])
  .meta({ id: 'Caption', description: 'Caption text, or {kicker, text}.' });

export const EaseSpecSchema: z.ZodType<EaseSpec> = z
  .union([
    z.enum(['slow', 'normal', 'fast', 'linear']),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
  ])
  .meta({ id: 'Ease', description: 'Easing preset or cubic-bezier [x1, y1, x2, y2].' });

export const CameraHintSchema: z.ZodType<CameraHint> = z
  .strictObject({
    zoom: z.number().min(1).max(3).describe('Zoom factor (1 = none). Clamped to the template max_zoom.'),
    target: z
      .union([z.enum(['cursor', 'step']), PointSchema, TargetSpecSchema])
      .describe('What to centre on. Default: the step target, else the cursor.')
      .optional(),
    ease: EaseSpecSchema.optional(),
    duration: z.number().min(0.8).describe('Duration of the zoom move in seconds (≥ 0.8).').optional(),
    until: z
      .union([z.enum(['step_end', 'scene_end']), z.number().gt(0)])
      .describe('How long the zoom stays: step_end, scene_end (default) or N seconds.')
      .optional(),
  })
  .meta({ id: 'CameraHint', description: 'Edit-time camera move keyed to this step. The camera is static otherwise.' });

export const FRAME_STYLES: readonly FrameStyle[] = ['raw', 'card', 'browser', 'laptop', 'phone', 'tablet'];

export const FrameStyleSchema = z
  .enum(['raw', 'card', 'browser', 'laptop', 'phone', 'tablet'])
  .describe('How the capture is framed: raw, card, browser chrome, laptop, phone or tablet mockup.');

/** Component ids: "namespace/name", lower-case letters, digits and "-" on each side. */
export const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

const COMPONENT_ID_RULE = 'lower-case letters, digits and "-", e.g. "studio/intro-stack"';

/** A component id ("namespace/name"); `what` names the field in the message ("layout component id"…). */
export function componentIdSchema(what = 'component id') {
  return z.string().regex(COMPONENT_ID_RE, {
    error: (iss) => `${what} must be "namespace/name" (${COMPONENT_ID_RULE}), got ${JSON.stringify(iss.input)}`,
  });
}

export const ComponentKindSchema = z.enum(COMPONENT_KINDS as [string, ...string[]]);

export const ComponentParamsSchema = z
  .record(z.string(), z.unknown())
  .describe("Component params (see the component's params schema; unset params take its defaults).");

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

/** Slot values of a component use (title, kicker, text…). */
export const SlotsSchema = z
  .record(keyString('slot name'), z.string())
  .describe('Slot values (title, kicker, text…) as the component declares them.');

/** A FrameStyle or a layout component id. */
export const FrameSpecSchema: z.ZodType<FrameSpec> = z
  .union([
    FrameStyleSchema,
    z.string().regex(COMPONENT_ID_RE, {
      error: (iss) =>
        `expected a frame style (${FRAME_STYLES.join(', ')}) or a layout component id "namespace/name" ` +
        `(${COMPONENT_ID_RULE.replace('studio/intro-stack', 'studio/layout-card')}), got ${JSON.stringify(iss.input)}` +
        suggestion(String(iss.input), FRAME_STYLES),
    }).describe('A layout component id "namespace/name", e.g. studio/layout-card or a workspace layout.'),
  ])
  .meta({
    id: 'Frame',
    description:
      'How the capture is framed: raw, card, browser, laptop, phone or tablet (built-in layouts studio/layout-<style>), ' +
      'or a layout component id "namespace/name".',
  });

export const TransitionSchema = z.enum(['crossfade', 'cut', 'fade-black']);

/** Transition INTO a scene or a card: a kind, a transition component id, or {component, params}. */
export const SceneTransitionSchema: z.ZodType<SceneTransition> = z
  .union([
    TransitionSchema,
    componentIdSchema('transition component id'),
    z.strictObject({
      component: componentIdSchema('transition component id').describe('Transition component "namespace/name", e.g. studio/transition-tap-open.'),
      params: ComponentParamsSchema.optional(),
    }),
  ])
  .meta({
    id: 'SceneTransition',
    description:
      'crossfade, cut or fade-black (the theme\'s transition of that kind), or a transition component: its id ' +
      '(e.g. studio/transition-tap-open) or {component, params}.',
  });

// ── Tutorial overlays (L2.10) ────────────────────────────────────────────────

const tutorialComponent = () =>
  componentIdSchema('tutorial overlay component id').describe('Overlay component drawing it (default: the built-in one), "namespace/name".');

/** One tutorial overlay: on / off, or {component?, params?}. */
const TutorialFeatureSchema = z.union([
  z.boolean(),
  z.strictObject({ component: tutorialComponent().optional(), params: ComponentParamsSchema.optional() }),
]);

const SpotlightModeSchema = z.enum(['steps', 'clicks']);
const ChapterModeSchema = z.enum(['scenes', 'cards']);

export const TutorialSpecSchema = z
  .strictObject({
    shortcuts: TutorialFeatureSchema.describe('Key caps of `press` steps, timed on the real key press (studio/overlay-shortcut).').optional(),
    spotlight: z
      .union([
        z.boolean(),
        SpotlightModeSchema,
        z.strictObject({
          on: SpotlightModeSchema.describe('steps: every step with a target, over the whole step; clicks: around each click.').optional(),
          component: tutorialComponent().optional(),
          params: ComponentParamsSchema.optional(),
        }),
      ])
      .describe("Dim the screen except the step's target (studio/overlay-spotlight): steps (= true), clicks, false or {on, component, params}.")
      .optional(),
    steps: TutorialFeatureSchema.describe('Numbered badges (1, 2, 3…) next to clicked targets (studio/overlay-steps).').optional(),
    loupe: TutorialFeatureSchema.describe('A magnified view of the field during `type` steps (studio/overlay-loupe).').optional(),
    progress: z
      .union([
        z.boolean(),
        ChapterModeSchema,
        z.strictObject({
          chapters: ChapterModeSchema.describe('scenes: every scene and card is a chapter; cards: each card opens a chapter.').optional(),
          component: tutorialComponent().optional(),
          params: ComponentParamsSchema.optional(),
        }),
      ])
      .describe('Chapter progress bar across the video (studio/overlay-progress), scenario level only: scenes (= true), cards, false or {chapters, component, params}.')
      .optional(),
  })
  .meta({ id: 'TutorialSpec', description: 'Automatic tutorial overlays fed by the timeline; the most specific level (step → scene → scenario) wins.' });

export const TutorialSwitchSchema: z.ZodType<TutorialSwitch> = z.union([z.boolean(), TutorialSpecSchema]).meta({
  id: 'Tutorial',
  description: 'Tutorial overlays: true (all on), false (all off) or the switches {shortcuts, spotlight, steps, loupe, progress}.',
});
