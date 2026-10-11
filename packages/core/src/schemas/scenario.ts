import { z } from 'zod';
import { keyedUnion } from './keyed.js';
import { HookStepSchema } from './hooks.js';
import {
  CaptionSpecSchema,
  FrameStyleSchema,
  PointSchema,
  TargetSpecSchema,
  TransitionSchema,
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
    transition: TransitionSchema.describe('Transition INTO this scene (default: template).').optional(),
    frame: FrameStyleSchema.optional(),
    irreversible: z.boolean().describe('Every step is irreversible (dry-run stops the scene at its first step).').optional(),
    skip: z.boolean().describe('Skip this scene entirely.').optional(),
    note: z.string().optional(),
  })
  .meta({ id: 'Scene', title: 'scene', description: 'A captured scene: optional page + open, then steps.' });

export const InterstitialSchema = z
  .strictObject({
    interstitial: z.strictObject({
      text: nonEmpty().describe('Card text, e.g. "A few hours later".'),
      kicker: z.string().optional(),
      duration: positiveSeconds().describe('Seconds on screen.').optional(),
      style: nonEmpty().describe('Template interstitial style override.').optional(),
    }),
    id: slugString('scene id').optional(),
  })
  .meta({ id: 'Interstitial', title: 'interstitial', description: 'A title card between scenes (takes no capture time).' });

export const SceneEntrySchema = keyedUnion(
  [SceneSchema, InterstitialSchema],
  {
    noun: 'scene',
    label: 'scene kind',
    keys: ['interstitial'],
    branchOf: new Map([['interstitial', 1]]),
    fallback: 0,
    common: [],
    example: 'e.g. "id: import" with "steps:", or "interstitial: {text: …}"',
  },
  { id: 'SceneEntry', description: 'A scene or an interstitial card.' },
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
      .union([z.literal(false), z.strictObject({ duration: positiveSeconds().optional() })])
      .describe('`false` disables the intro card.')
      .optional(),
    outro: z
      .union([
        z.literal(false),
        z.strictObject({
          tagline: z.string().optional(),
          url: z.string().optional(),
          duration: positiveSeconds().optional(),
        }),
      ])
      .describe('`false` disables the outro card.')
      .optional(),
    env: nonEmpty().describe('Environment name (default: project default_env, else the first one).').optional(),
    vars: z
      .record(z.string(), z.string())
      .describe('Free variables usable as {{vars.x}} (and {{x}} when not shadowed).')
      .optional(),
    setup: z.array(HookStepSchema).describe('Hooks run before capture (rolled back automatically).').optional(),
    teardown: z.array(HookStepSchema).describe('Hooks run after capture, even after a failure.').optional(),
    capture: CapturePartialSchema.optional(),
    frame: FrameStyleSchema.optional(),
    template: nonEmpty().describe('Template name (default: the project template).').optional(),
    pacing: PacingPartialSchema.optional(),
    music: z
      .strictObject({
        file: nonEmpty().describe('Audio file relative to the project dir.'),
        volume: z.number().min(0).max(1).optional(),
        duck: z.number().min(0).max(1).describe('Volume factor under footage.').optional(),
      })
      .optional(),
    scenes: z.array(SceneEntrySchema).min(1).describe('Scenes and interstitials, in order.'),
  })
  .meta({ id: 'Scenario', title: 'Demo Studio scenario', description: 'A product video: hooks, scenes and steps.' });
