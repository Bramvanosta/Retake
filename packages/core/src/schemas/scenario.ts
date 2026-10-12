import { z } from 'zod';
import { keyedUnion } from './keyed.js';
import { HookStepSchema } from './hooks.js';
import {
  CaptionSpecSchema,
  ComponentParamsSchema,
  FrameSpecSchema,
  PointSchema,
  SlotsSchema,
  TargetSpecSchema,
  SceneTransitionSchema,
  componentIdSchema,
  keyString,
  nonEmpty,
  positiveSeconds,
  seconds,
  slugString,
} from './primitives.js';
import { CapturePartialSchema, PacingPartialSchema } from './settings.js';
import { StepSchema, speedSchema } from './steps.js';

export const SceneCursorSchema = z
  .union([z.enum(['auto', 'keep']), PointSchema, TargetSpecSchema])
  .meta({
    id: 'SceneCursor',
    description:
      "Where the cursor rests at the scene start: 'auto' (default: a neutral point near the first pointer target, never on it), " +
      "'keep' (where the previous scene left it), a viewport point {x, y}, or a target to rest on. Use {text: auto} for an element whose text is \"auto\".",
  });

export const SceneSchema = z
  .strictObject({
    id: slugString('scene id').describe('Unique, slug-like scene id.'),
    caption: CaptionSpecSchema.describe('Caption for the whole scene (a step caption replaces it).').optional(),
    page: keyString('page')
      .describe("Environment page key (e.g. console, shop). Default: the previous scene's page, else the first key.")
      .optional(),
    open: nonEmpty().describe("Path or URL opened at scene start. Omit to continue from the previous scene's state.").optional(),
    steps: z.array(StepSchema).describe('Actions, in order.'),
    speed: speedSchema().describe('Edit-time speed for the whole scene, in (0, 8].').optional(),
    still: seconds().describe('Seconds of stillness at scene start (default pacing.scene_start_still).').optional(),
    cursor: SceneCursorSchema.optional(),
    transition: SceneTransitionSchema.describe('Transition INTO this scene: crossfade, cut, fade-black or a transition component (default: the theme\'s).').optional(),
    frame: FrameSpecSchema.describe(
      'Frame of this scene (default: the scenario frame, else the project frame): raw, card, browser, laptop, phone, tablet or a layout component id "namespace/name".',
    ).optional(),
    irreversible: z.boolean().describe('Every step is irreversible (dry-run stops the scene at its first step).').optional(),
    skip: z.boolean().describe('Skip this scene entirely.').optional(),
    note: z.string().optional(),
  })
  .meta({ id: 'Scene', title: 'scene', description: 'A captured scene: optional page + open, then steps.' });

export const InterstitialSchema = z
  .strictObject({
    interstitial: z
      .strictObject({
        text: nonEmpty().describe('Card text, e.g. "A few hours later".'),
        kicker: z.string().describe('Small line above the text.').optional(),
        duration: positiveSeconds().describe('Seconds on screen.').optional(),
        style: nonEmpty()
          .describe('Legacy template interstitial style override (dark-clock, paper, dark); ignored when `component` is set.')
          .optional(),
        component: componentIdSchema('interstitial component id')
          .describe('Interstitial component "namespace/name" (default: the theme\'s), e.g. studio/interstitial-clock.')
          .optional(),
        params: ComponentParamsSchema.optional(),
      })
      .describe('"Time passes" card: text, kicker, duration, component, params.'),
    id: slugString('scene id').describe('Interstitial id (default "interstitial-<index>").').optional(),
  })
  .meta({ id: 'Interstitial', title: 'interstitial', description: 'A "time passes" card between scenes (takes no capture time).' });

export const CardSchema = z
  .strictObject({
    card: z
      .strictObject({
        component: componentIdSchema('card component id')
          .describe('Card component "namespace/name" (default: the theme\'s card component, studio/card-title).')
          .optional(),
        params: ComponentParamsSchema.optional(),
        slots: SlotsSchema.describe(
          'Slot values: title, kicker, text… as the component declares them (a card without `component` needs `title`).',
        ).optional(),
        duration: positiveSeconds().describe("Seconds on screen (default: the component's duration).").optional(),
        transition: SceneTransitionSchema.describe(
          "Transition INTO this card: crossfade, cut, fade-black or a transition component, e.g. studio/transition-tap-open (default: the theme's).",
        ).optional(),
      })
      .describe('Full-screen card: component, params, slots, duration, transition.'),
    id: slugString('scene id').describe('Card id (default "card-<index>").').optional(),
  })
  .meta({
    id: 'Card',
    title: 'card',
    description: 'A generic full-screen card between scenes (title, chapter, quote…); takes no capture time.',
  });

export const SceneEntrySchema = keyedUnion(
  [SceneSchema, InterstitialSchema, CardSchema],
  {
    noun: 'scene',
    label: 'scene kind',
    keys: ['interstitial', 'card'],
    branchOf: new Map([
      ['interstitial', 1],
      ['card', 2],
    ]),
    fallback: 0,
    common: [],
    example: 'e.g. "id: import" with "steps:", "interstitial: {text: …}" or "card: {slots: {title: …}}"',
  },
  { id: 'SceneEntry', description: 'A captured scene, an interstitial or a card.' },
);

const TitleSchema = z.strictObject({
  kicker: z.string().describe('Small line above the title.').optional(),
  text: nonEmpty().describe('Video title shown by the intro card.'),
});

export const ScenarioSchema = z
  .strictObject({
    video: slugString('video').describe('Video name (usually the scenario file name).'),
    title: TitleSchema.optional(),
    intro: z
      .union([
        z.literal(false),
        z.strictObject({
          component: componentIdSchema('intro component id')
            .describe('Intro component "namespace/name" (default: the theme\'s), e.g. studio/intro-stack.')
            .optional(),
          params: ComponentParamsSchema.optional(),
          duration: positiveSeconds().describe('Seconds (default: template intro.duration).').optional(),
        }),
      ])
      .describe('Intro card overrides {component, params, duration}; `false` disables the intro card.')
      .optional(),
    outro: z
      .union([
        z.literal(false),
        z.strictObject({
          component: componentIdSchema('outro component id')
            .describe('Outro component "namespace/name" (default: the theme\'s), e.g. studio/outro-stack.')
            .optional(),
          params: ComponentParamsSchema.optional(),
          tagline: z.string().describe('Tagline under the logo (default: template outro.tagline).').optional(),
          url: z.string().describe('URL shown by the outro (default: template outro.url, else brand.url).').optional(),
          duration: positiveSeconds().describe('Seconds (default: template outro.duration).').optional(),
        }),
      ])
      .describe('Outro card overrides {component, params, tagline, url, duration}; `false` disables the outro card.')
      .optional(),
    env: nonEmpty().describe('Environment name (default: project default_env, else the first one).').optional(),
    vars: z
      .record(z.string(), z.string())
      .describe('Free variables usable as {{vars.x}} (and {{x}} when not shadowed).')
      .optional(),
    setup: z.array(HookStepSchema).describe('Hooks run before capture (rolled back automatically).').optional(),
    teardown: z.array(HookStepSchema).describe('Hooks run after capture, even after a failure.').optional(),
    capture: CapturePartialSchema.optional(),
    frame: FrameSpecSchema.describe(
      'Frame of every scene (default: the project frame): raw, card, browser, laptop, phone, tablet or a layout component id "namespace/name".',
    ).optional(),
    template: nonEmpty().describe('Template name (default: the project template).').optional(),
    pacing: PacingPartialSchema.optional(),
    music: z
      .strictObject({
        file: nonEmpty().describe('Audio file relative to the project dir.'),
        volume: z.number().min(0).max(1).describe('Base volume (intro, outro, cards): 0–1, default 0.6.').optional(),
        duck: z.number().min(0).max(1).describe('Volume factor under footage: 0–1, default 0.5.').optional(),
        loop: z.boolean().describe('Loop a track shorter than the video (default true, crossfaded seams); false: play it once.').optional(),
      })
      .optional(),
    scenes: z.array(SceneEntrySchema).min(1).describe('Scenes, cards and interstitials, in order.'),
  })
  .meta({ id: 'Scenario', title: 'Demo Studio scenario', description: 'A product video: hooks, scenes and steps.' });
