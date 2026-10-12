import { z } from 'zod';
import { ACTION_NAMES } from '../types.js';
import type { RunRecord, Timeline } from '../types.js';
import {
  BBoxSchema,
  ComponentParamsSchema,
  EaseSpecSchema,
  FrameSpecSchema,
  PointSchema,
  TargetSpecSchema,
  SceneTransitionSchema,
  TutorialSwitchSchema,
  nonEmpty,
} from './primitives.js';

const t = () => z.number().min(0).describe('Capture time in seconds.');
const CaptionObject = z.strictObject({ kicker: z.string().optional(), text: z.string() });

const ViewportObject = z.strictObject({
  width: z.number().int().gt(0),
  height: z.number().int().gt(0),
  mobile: z.boolean().optional(),
  touch: z.boolean().optional(),
  preset: z.enum(['desktop', 'laptop', 'tablet', 'mobile']).optional(),
});

const PageSegmentSchema = z.strictObject({ id: nonEmpty(), t_start: t(), t_end: t(), url: z.string().optional() });
const CursorSampleSchema = z.strictObject({ t: t(), x: z.number(), y: z.number(), visible: z.boolean(), down: z.boolean().optional() });

const TimelineSceneSchema = z.strictObject({
  id: nonEmpty(),
  index: z.number().int().min(0),
  kind: z.enum(['scene', 'interstitial', 'card']),
  t_start: t(),
  t_end: t(),
  t_actions: t().optional(),
  page: z.string().optional(),
  url: z.string().optional(),
  caption: CaptionObject.optional(),
  speed: z.number().gt(0).optional(),
  transition: SceneTransitionSchema.optional(),
  frame: FrameSpecSchema.optional(),
  interstitial: z
    .strictObject({
      text: z.string(),
      kicker: z.string().optional(),
      duration: z.number().optional(),
      style: z.string().optional(),
      component: z.string().optional(),
      params: ComponentParamsSchema.optional(),
    })
    .optional(),
  card: z
    .strictObject({
      component: z.string().optional(),
      params: ComponentParamsSchema.optional(),
      slots: z.record(z.string(), z.string()).optional(),
      duration: z.number().optional(),
      transition: SceneTransitionSchema.optional(),
    })
    .optional(),
  tutorial: TutorialSwitchSchema.optional(),
  pages: z
    .array(
      z.strictObject({
        id: nonEmpty(),
        page: z.string().optional(),
        label: z.string().optional(),
        viewport: ViewportObject,
        url: z.string().optional(),
        track: nonEmpty(),
      }),
    )
    .describe('Multi-page scene: the pages filmed at the same time, each on its own track.')
    .optional(),
  status: z.enum(['ok', 'failed', 'skipped', 'partial']),
});

const TimelineTrackSchema = z
  .strictObject({
    id: nonEmpty(),
    file: z.string().describe('CFR video relative to the run directory (capture-<page>.mp4).'),
    frames_file: z.string(),
    width: z.number().int().gt(0),
    height: z.number().int().gt(0),
    scale: z.number().gt(0),
    mobile: z.boolean().optional(),
    touch: z.boolean().optional(),
    preset: z.enum(['desktop', 'laptop', 'tablet', 'mobile']).optional(),
    fps: z.number().gt(0),
    frames: z.number().int().min(0),
    recording: z.array(z.strictObject({ t_start: t(), t_end: t() })),
    pages: z.array(PageSegmentSchema),
    cursor: z.array(CursorSampleSchema),
  })
  .describe('A page recorded on its own track (multi-page scenes), on the capture clock.');

const IntroOutroBase = { component: z.string().optional(), params: ComponentParamsSchema.optional(), duration: z.number().optional() };

const TimelineVideoSchema = z
  .strictObject({
    title: z.strictObject({ kicker: z.string().optional(), text: z.string() }).optional(),
    intro: z.union([z.literal(false), z.strictObject(IntroOutroBase)]).optional(),
    outro: z
      .union([z.literal(false), z.strictObject({ ...IntroOutroBase, tagline: z.string().optional(), url: z.string().optional() })])
      .optional(),
    frame: FrameSpecSchema.optional(),
    template: z.string().optional(),
    music: z.strictObject({ file: z.string(), volume: z.number().optional(), duck: z.number().optional(), loop: z.boolean().optional() }).optional(),
    tutorial: TutorialSwitchSchema.optional(),
  })
  .describe("The scenario's edit info: title, intro, outro, effective frame, template, music.");

const TimelineEventSchema = z.strictObject({
  scene: nonEmpty(),
  scene_index: z.number().int().min(0),
  step: z.number().int(),
  id: z.string().optional(),
  action: z.enum([...ACTION_NAMES, 'scene_open', 'scene_still', 'notification']),
  t_start: t(),
  t_end: t(),
  hold: z.strictObject({ t_start: t(), t_end: t() }).optional(),
  t_click: t().optional(),
  target: z.strictObject({ desc: z.string(), bbox: BBoxSchema.optional() }).optional(),
  point: PointSchema.optional(),
  mark: z.string().optional(),
  caption: CaptionObject.optional(),
  speed: z.number().gt(0).optional(),
  camera: z
    .strictObject({
      zoom: z.number(),
      target: z.union([z.enum(['cursor', 'step']), PointSchema, TargetSpecSchema]).optional(),
      ease: EaseSpecSchema.optional(),
      duration: z.number().optional(),
      until: z.union([z.enum(['step_end', 'scene_end']), z.number()]).optional(),
      bbox: BBoxSchema.optional(),
      point: PointSchema.optional(),
    })
    .optional(),
  overlay: z
    .strictObject({
      component: nonEmpty(),
      slots: z.record(z.string(), z.string()),
      params: ComponentParamsSchema,
      duration: z.number().gt(0).optional(),
      target: z.string().describe('Description of the measured target.').optional(),
      bbox: BBoxSchema.describe('Target bbox at the end of the step (after any scroll).').optional(),
      point: PointSchema.describe('Anchor when there is no target bbox (cursor at the end of the step).').optional(),
    })
    .optional(),
  tutorial: TutorialSwitchSchema.optional(),
  page: z.string().optional(),
  url: z.string().optional(),
  status: z.enum(['ok', 'skipped', 'failed', 'dry']),
  strategy: z.string().optional(),
  popup_opened: z.boolean().optional(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});

const ArtefactImageSchema = z.strictObject({
  file: nonEmpty().describe('Relative to the run directory.'),
  width: z.number().int().gt(0),
  height: z.number().int().gt(0),
});

const artefactBase = {
  name: nonEmpty(),
  t: t(),
  scene: z.string().optional(),
  step: z.number().int().optional(),
  file: nonEmpty().describe('Relative to the run directory.'),
};

const TimelineArtefactSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('email'),
      ...artefactBase,
      from: z.string(),
      from_name: z.string().optional(),
      to: z.array(z.string()),
      subject: z.string(),
      date: z.string(),
      preview: z.string(),
      image: ArtefactImageSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal('document'),
      ...artefactBase,
      mime: z.string(),
      file_name: z.string(),
      via: z.enum(['download', 'tab', 'project']),
      url: z.string().optional(),
      bytes: z.number().int().min(0),
      pages: z.array(ArtefactImageSchema.extend({ width_pt: z.number().gt(0), height_pt: z.number().gt(0) })),
    }),
    z.strictObject({
      kind: z.literal('notification'),
      ...artefactBase,
      index: z.number().int().min(1),
      title: z.string(),
      body: z.string(),
      tag: z.string().optional(),
      icon: ArtefactImageSchema.optional(),
      icon_url: z.string().optional(),
      origin: z.string(),
      page: z.string().optional(),
      via: z.enum(['Notification', 'ServiceWorkerRegistration.showNotification']),
      time: z.string(),
    }),
    z.strictObject({
      kind: z.literal('text'),
      ...artefactBase,
      value: z.string(),
      text: z.string(),
      target: z.string(),
      bbox: BBoxSchema.optional(),
      pattern: z.string().optional(),
    }),
  ])
  .describe('A captured email, document or web notification (L2.9), or a text read by capture_text (L2.10).');

export const TimelineSchema = z
  .strictObject({
    version: z.literal(1),
    run_id: nonEmpty(),
    project: nonEmpty(),
    scenario: nonEmpty(),
    created_at: nonEmpty().describe('ISO timestamp.'),
    mode: z.enum(['capture', 'dry']),
    capture: z.strictObject({
      file: z.string(),
      width: z.number().int().gt(0),
      height: z.number().int().gt(0),
      scale: z.number().gt(0),
      fps: z.number().gt(0),
      duration: z.number().min(0),
      t0_wall: z.number().describe('Wall-clock epoch ms of capture time 0.'),
      frames: z.number().int().min(0),
    }),
    video: TimelineVideoSchema.optional(),
    scenes: z.array(TimelineSceneSchema),
    events: z.array(TimelineEventSchema),
    markers: z.array(z.strictObject({ name: nonEmpty(), t: t(), scene: nonEmpty(), step: z.number().int(), page: z.string().optional() })),
    pages: z.array(PageSegmentSchema),
    cursor: z.array(CursorSampleSchema),
    idle: z.array(z.strictObject({ t_start: t(), t_end: t() })),
    artefacts: z.array(TimelineArtefactSchema).describe('Emails, documents, web notifications and texts captured by the run.').optional(),
    tracks: z.array(TimelineTrackSchema).describe('Multi-page scenes: one track per page, on the capture clock.').optional(),
    warnings: z.array(z.string()),
  })
  .meta({
    id: 'Timeline',
    title: 'Demo Studio timeline',
    description: 'runs/<id>/timeline.json: scenes, step events, markers, pages and cursor track in capture time.',
  }) satisfies z.ZodType<Timeline>;

export const RunRecordSchema = z
  .strictObject({
    id: nonEmpty(),
    project: nonEmpty(),
    scenario: nonEmpty(),
    mode: z.enum(['capture', 'dry']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    started_at: nonEmpty(),
    finished_at: z.string().optional(),
    dir: nonEmpty(),
    env: z.string(),
    options: z.strictObject({ until: z.string().optional(), hooks: z.enum(['run', 'skip']), headed: z.boolean() }),
    steps_total: z.number().int().min(0),
    steps_done: z.number().int().min(0),
    current: z.strictObject({ scene: z.string(), step: z.number().int(), action: z.string() }).optional(),
    capture: z.string().optional(),
    timeline: z.string().optional(),
    screenshots: z.array(z.string()),
    hooks: z.strictObject({
      setup: z.enum(['ok', 'failed', 'skipped', 'none']),
      teardown: z.enum(['ok', 'failed', 'skipped', 'none']),
    }),
    warnings: z.array(z.string()),
    error: z
      .strictObject({
        message: z.string(),
        scene: z.string().optional(),
        step: z.number().int().optional(),
        action: z.string().optional(),
        screenshot: z.string().optional(),
        dom: z.string().optional(),
      })
      .optional(),
    stopped_at: z
      .strictObject({ scene: z.string(), step: z.number().int(), reason: z.enum(['irreversible', 'until']) })
      .optional(),
  })
  .meta({ id: 'RunRecord', title: 'Demo Studio run record', description: 'runs/<id>/run.json' }) satisfies z.ZodType<RunRecord>;
