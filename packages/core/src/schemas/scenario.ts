import { z } from 'zod';
import { keyedUnion } from './keyed.js';
import { HookStepSchema } from './hooks.js';
import { ClockSpecSchema, WriteMockSchema } from './project.js';
import {
  CaptionSpecSchema,
  ComponentParamsSchema,
  FrameSpecSchema,
  PointSchema,
  SlotsSchema,
  TargetSpecSchema,
  SceneTransitionSchema,
  TutorialSwitchSchema,
  componentIdSchema,
  fileVersion,
  keyString,
  mediaFileShape,
  nonEmpty,
  positiveSeconds,
  seconds,
  slugString,
} from './primitives.js';
import { CapturePartialSchema, PacingPartialSchema, RunDefaultsSchema } from './settings.js';
import { StepSchema, speedSchema } from './steps.js';

export const SceneCursorSchema = z
  .union([z.enum(['auto', 'keep']), PointSchema, TargetSpecSchema])
  .meta({
    id: 'SceneCursor',
    description:
      "Where the cursor rests at the scene start: 'auto' (default: a neutral point near the first pointer target, never on it), " +
      "'keep' (where the previous scene left it), a viewport point {x, y}, or a target to rest on. Use {text: auto} for an element whose text is \"auto\".",
  });

export const ViewportSchema = z
  .union([
    z.enum(['desktop', 'laptop', 'tablet', 'mobile']),
    z.strictObject({
      width: z.number().int().min(200).max(7680).describe('Viewport width in CSS px.'),
      height: z.number().int().min(200).max(4320).describe('Viewport height in CSS px.'),
      mobile: z.boolean().describe('Emulate a mobile device (meta viewport, overlay scrollbars).').optional(),
      touch: z.boolean().describe('Emulate a touch screen (default: as `mobile`).').optional(),
    }),
  ])
  .meta({
    id: 'Viewport',
    description: 'A page viewport: desktop (the capture size), laptop (1440×900), tablet (820×1180), mobile (390×844) or {width, height, mobile?, touch?}.',
  });

const scenePageShape = {
  page: keyString('page')
    .describe('Environment page key whose base URL a relative `open` resolves against (default: the page id when it is one, else the key before ":" in `open`).')
    .optional(),
  open: nonEmpty()
    .describe('Opened at the scene start: a path, "<environment page>:<path>" (e.g. shop:/products) or a URL. Omit to continue the page as it is.')
    .optional(),
  viewport: ViewportSchema.optional(),
  label: nonEmpty().describe('Name a layout may show next to the page ("Buyer").').optional(),
  cursor: SceneCursorSchema.optional(),
  persona: slugString('persona')
    .describe('The persona this page is signed in as (project auth.personas), or none. Default: the persona whose `pages` list its environment page.')
    .optional(),
};

export const ScenePageSchema = z.strictObject(scenePageShape).meta({ id: 'ScenePage', description: 'One page of a multi-page scene.' });

export const ScenePagesSchema = z
  .union([
    z.record(keyString('page id'), ScenePageSchema.nullable()),
    z.array(z.union([keyString('page'), z.strictObject({ id: keyString('page id').optional(), ...scenePageShape })])),
  ])
  .meta({
    id: 'ScenePages',
    description:
      'Pages filmed at the same time (instead of `page` / `open`): a map page id → {page?, open?, viewport?, label?, cursor?, persona?}, or a list of ' +
      'environment page keys / {id?, page, open?, viewport?…} (default id: the page key, plus "-<preset>" for another viewport than desktop).',
  });

export const SceneSchema = z
  .strictObject({
    id: slugString('scene id').describe('Unique, slug-like scene id.'),
    caption: CaptionSpecSchema.describe('Caption for the whole scene (a step caption replaces it).').optional(),
    page: keyString('page')
      .describe("Environment page key (e.g. console, shop). Default: the previous scene's page, else the first key.")
      .optional(),
    open: nonEmpty().describe("Path or URL opened at scene start. Omit to continue from the previous scene's state.").optional(),
    pages: ScenePagesSchema.optional(),
    persona: slugString('persona')
      .describe(
        "The persona this scene's page is signed in as (project auth.personas), or none. Default: the persona whose `pages` list the environment page; a page keeps one persona for the whole run.",
      )
      .optional(),
    steps: z.array(StepSchema).describe('Actions, in order.'),
    speed: speedSchema().describe('Edit-time speed for the whole scene, in (0, 8].').optional(),
    still: seconds().describe('Seconds of stillness at scene start (default pacing.scene_start_still).').optional(),
    cursor: SceneCursorSchema.optional(),
    transition: SceneTransitionSchema.describe('Transition INTO this scene: crossfade, cut, fade-black or a transition component (default: the theme\'s).').optional(),
    frame: FrameSpecSchema.describe(
      'Frame of this scene (default: the scenario frame, else the project frame): raw, card, browser, laptop, phone, tablet, split / pip (multi-page scenes) or a layout component id "namespace/name".',
    ).optional(),
    tutorial: TutorialSwitchSchema.describe("Tutorial overlays of this scene's steps, over the scenario's (progress is scenario-only).").optional(),
    irreversible: z.boolean().describe('Every step is irreversible (dry-run stops the scene at its first step).').optional(),
    skip: z.boolean().describe('Skip this scene entirely.').optional(),
    note: z.string().optional(),
  })
  .meta({ id: 'Scene', title: 'scene', description: 'A captured scene: optional page + open, then steps.' });

export const InterstitialSchema = z
  .strictObject({
    interstitial: z
      .strictObject({
        text: nonEmpty().describe('Card text, e.g. "A few hours later" (not needed for a video, image or lottie file).').optional(),
        kicker: z.string().describe('Small line above the text.').optional(),
        duration: positiveSeconds().describe('Seconds on screen.').optional(),
        style: nonEmpty()
          .describe('Legacy template interstitial style override (dark-clock, paper, dark); ignored when `component` is set.')
          .optional(),
        component: componentIdSchema('interstitial component id')
          .describe('Interstitial component "namespace/name" (default: the theme\'s), e.g. studio/interstitial-clock.')
          .optional(),
        params: ComponentParamsSchema.optional(),
        ...mediaFileShape,
      })
      .describe('"Time passes" card: text, kicker, duration, component, params — or a video, image or lottie file.'),
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
        duration: positiveSeconds().describe("Seconds on screen (default: the component's duration; a video or Lottie file: its own length).").optional(),
        transition: SceneTransitionSchema.describe(
          "Transition INTO this card: crossfade, cut, fade-black or a transition component, e.g. studio/transition-tap-open (default: the theme's).",
        ).optional(),
        ...mediaFileShape,
      })
      .describe('Full-screen card: component, params, slots, duration, transition — or a video, image or lottie file.'),
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
    version: fileVersion(),
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
          duration: positiveSeconds().describe('Seconds (default: template intro.duration; a video or Lottie file: its own length).').optional(),
          ...mediaFileShape,
        }),
      ])
      .describe('Intro card overrides {component, params, duration}, or your own file {video | image | lottie, …}; `false` disables the intro card.')
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
          duration: positiveSeconds().describe('Seconds (default: template outro.duration; a video or Lottie file: its own length).').optional(),
          ...mediaFileShape,
        }),
      ])
      .describe('Outro card overrides {component, params, tagline, url, duration}, or your own file {video | image | lottie, …}; `false` disables the outro card.')
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
    defaults: RunDefaultsSchema.describe("Step defaults (win over the project's), e.g. {timeout_s: 30} for a product whose actions take long.").optional(),
    music: z
      .strictObject({
        file: nonEmpty().describe('Audio file relative to the project dir.'),
        volume: z.number().min(0).max(1).describe('Base volume (intro, outro, cards): 0–1, default 0.6.').optional(),
        duck: z.number().min(0).max(1).describe('Volume factor under footage: 0–1, default 0.5.').optional(),
        loop: z.boolean().describe('Loop a track shorter than the video (default true, crossfaded seams); false: play it once.').optional(),
      })
      .optional(),
    tutorial: TutorialSwitchSchema.describe(
      'Automatic tutorial overlays fed by the timeline: true, false or {shortcuts, spotlight, steps, loupe, progress}.',
    ).optional(),
    target_length: z
      .strictObject({
        min_s: z.number().gt(0).max(7200).describe('Shortest length the video aims at, seconds.'),
        max_s: z.number().gt(0).max(7200).describe('Longest length the video aims at, seconds.'),
      })
      .refine((v) => v.min_s <= v.max_s, { message: 'min_s is at most max_s' })
      .describe("The length this video aims at (L5.5): the review's video-length rule uses it instead of the reference 60–120 s.")
      .optional(),
    clock: z
      .union([z.literal(false), ClockSpecSchema])
      .describe('The product\'s clock when the capture starts (wins over the project\'s): an ISO date-time or {at, freeze}; false turns the project\'s clock off.')
      .optional(),
    mocks: z
      .array(WriteMockSchema)
      .describe('Answers to writes stopped on read-only runs (tried before the environment\'s read_only.mocks); ignored on read-write runs.')
      .optional(),
    scenes: z.array(SceneEntrySchema).min(1).describe('Scenes, cards and interstitials, in order.'),
  })
  .meta({ id: 'Scenario', title: 'Demo Studio scenario', description: 'A product video: hooks, scenes and steps.' });
