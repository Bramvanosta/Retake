import { z } from 'zod';
import { ACTION_NAMES, CURSOR_ICONS, ENVIRONMENT_ACCESS, SANDBOX_PROVIDERS, SANDBOX_RESET_STRATEGIES } from '../types.js';
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
  mediaFileShape,
  fileVersion,
  nonEmpty,
} from './primitives.js';
import { OverlayAnchorSchema, OverlayAtSchema } from './steps.js';

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
const CursorEffectSchema = z
  .strictObject({
    t: t(),
    type: z.enum(['icon', 'press', 'release', 'ripple']),
    icon: z.enum(CURSOR_ICONS).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .describe('What the in-page cursor showed besides its position: icon change, press, release or click ripple (CSS px).');

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
      text: z.string().optional(),
      kicker: z.string().optional(),
      duration: z.number().optional(),
      style: z.string().optional(),
      component: z.string().optional(),
      params: ComponentParamsSchema.optional(),
      ...mediaFileShape,
    })
    .optional(),
  card: z
    .strictObject({
      component: z.string().optional(),
      params: ComponentParamsSchema.optional(),
      slots: z.record(z.string(), z.string()).optional(),
      duration: z.number().optional(),
      transition: SceneTransitionSchema.optional(),
      ...mediaFileShape,
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
  offscreen: z.literal(true).describe('Played during the take but left out of the video (scene `offscreen: true`).').optional(),
  status: z.enum(['ok', 'failed', 'skipped', 'partial']),
});

const LoadingSchema = z
  .strictObject({
    t_start: t(),
    t_end: t(),
    page: z.string().optional(),
    until: z.enum(['paint', 'load', 'limit', 'left', 'end']),
    held_frames: z.number().int().min(0),
  })
  .describe(
    'A full-page load the capture did not show (R-ISS-08): the previous frame stayed on screen from the commit until the new page painted; no frame lies in [t_start, t_end), t_end is the first frame written after it (else the end of the hold).',
  );

const StallSchema = z
  .strictObject({ t_start: t(), t_end: t(), during: z.enum(['move', 'ripple']) })
  .describe('The capture froze (no new frame from t_start to t_end) while the cursor moved or a click ripple played: the edit cuts the frozen part.');

const BusySchema = z
  .strictObject({ t_start: t(), t_end: t(), click: t().describe('Capture time of the click it followed.') })
  .describe('A wait the screen showed after a click (near-identical frames: a skeleton, a spinner, a blank panel): the edit shortens it.');

const PauseSchema = z
  .strictObject({ t: t(), ms: z.number().int().min(0).describe('Wall ms the pause lasted, left out of capture time.'), scene: z.string(), step: z.number().int() })
  .describe('A pause of the take between steps (L4.4): capture time did not run meanwhile; the video goes on at t from where it paused.');

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
    cursor_effects: z.array(CursorEffectSchema).optional(),
    loading: z.array(LoadingSchema).describe('Page loads this track did not show.').optional(),
  })
  .describe('A page recorded on its own track (multi-page scenes), on the capture clock.');

const IntroOutroBase = { component: z.string().optional(), params: ComponentParamsSchema.optional(), duration: z.number().optional(), ...mediaFileShape };

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
    target_length: z.strictObject({ min_s: z.number(), max_s: z.number() }).optional(),
    caption_component: z.string().optional(),
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
  end_point: PointSchema.describe('Cursor at the end of the step, before any park or hold (L5.5): anchors an overlay or a zoom added after the capture.').optional(),
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
      at: OverlayAtSchema.optional(),
      box: z
        .strictObject({ anchor: OverlayAnchorSchema.optional(), rect: BBoxSchema.optional(), scale: z.number().gt(0).optional() })
        .describe('A box-filling overlay (a user file): where its box goes.')
        .optional(),
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
      persona: z.string().describe('The persona whose mailbox it was waited for in (to: persona:<name>).').optional(),
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

const ResolvedClockSchema = z.strictObject({
  at: nonEmpty().describe('As written (ISO 8601).'),
  epoch_ms: z.number().describe('The instant it names (epoch ms).'),
  timezone: z.string().describe("IANA zone a time without an offset was read in (browser.timezone, else the machine's).").optional(),
  freeze: z.literal(true).optional(),
});

const TimelineWriteSchema = z.strictObject({
  t: t().describe('Capture time; absent before capture time 0 (preflight, setup hooks).').optional(),
  method: nonEmpty(),
  url: z.string().describe('The real URL.'),
  operation: z.string().describe('GraphQL operation name.').optional(),
  outcome: z.enum(['blocked', 'mocked', 'allowed', 'passed', 'exempt']).describe('exempt: the automated sign-in\'s own write, from its sign-in page.'),
  rule: z.string().describe('The allow / mock entry that matched.').optional(),
  status: z.number().int().optional(),
  via: z.enum(['page', 'hook', 'sign-in']).optional(),
  protected_by: z.string().describe('The other, read-only environment whose host it went to.').optional(),
});

/** The sandbox of a run (L1.8): its provider, and the reset made before the take. */
const RunSandboxSchema = z
  .strictObject({
    name: nonEmpty().describe('The sandbox\'s environment.'),
    provider: z.enum(SANDBOX_PROVIDERS),
    strategy: z.enum(SANDBOX_RESET_STRATEGIES).describe('Absent: no reset before this take (--env <sandbox> without --sandbox).').optional(),
    restored: z.boolean().describe('A snapshot was restored (rather than the seed run again).').optional(),
    reset_ms: z.number().min(0).optional(),
    seed_hash: z.string().describe('The seed\'s hash (12 characters).').optional(),
    at: z.string().describe('When the reset finished (ISO).').optional(),
  })
  .describe('A sandbox environment (L1.8): its provider and the reset made before the take.');

const TimelineEnvironmentSchema = z
  .strictObject({
    name: nonEmpty(),
    production: z.literal(true).optional(),
    access: z.enum(ENVIRONMENT_ACCESS).describe("The run's effective access."),
    allow_writes: z.literal(true).describe('Written with --allow-writes (production, access: read-write).').optional(),
    display: z
      .array(z.strictObject({ page: nonEmpty(), url: z.string(), display: z.string() }))
      .describe('Display base of each page that declares one (url: its real base URL).')
      .optional(),
    clock: ResolvedClockSchema.optional(),
    writes: z.array(TimelineWriteSchema).describe('Writes the read-only guard stopped, answered or let through, and writes to hosts it does not guard.').optional(),
    sandbox: RunSandboxSchema.optional(),
  })
  .describe('The environment of the run (L1.7): access, display URLs, clock, writes seen on a read-only run.');

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
      t0_wall: z.number().describe('Wall-clock epoch ms of capture time 0 (a later wall time converts with `pauses` applied: less the ms of every earlier pause).'),
      frames: z.number().int().min(0),
      cursor: z.literal('hidden').describe('Captured without the in-page cursor (raw export for editors).').optional(),
    }),
    video: TimelineVideoSchema.optional(),
    scenes: z.array(TimelineSceneSchema),
    events: z.array(TimelineEventSchema),
    markers: z.array(z.strictObject({ name: nonEmpty(), t: t(), scene: nonEmpty(), step: z.number().int(), page: z.string().optional() })),
    pages: z.array(PageSegmentSchema),
    cursor: z.array(CursorSampleSchema),
    cursor_effects: z.array(CursorEffectSchema).describe('Icon changes, presses and click ripples of the in-page cursor of `capture`.').optional(),
    idle: z.array(z.strictObject({ t_start: t(), t_end: t() })),
    loading: z.array(LoadingSchema).describe('Page loads `capture` did not show (the previous frame held until the new page painted).').optional(),
    stalls: z.array(StallSchema).describe('Where `capture` froze while the cursor moved or a click ripple played.').optional(),
    busy: z.array(BusySchema).describe('Waits the screen showed after a click (skeletons, spinners, blank panels).').optional(),
    pauses: z.array(PauseSchema).describe('Where the take was paused between steps (from the Studio): not filmed.').optional(),
    artefacts: z.array(TimelineArtefactSchema).describe('Emails, documents, web notifications and texts captured by the run.').optional(),
    tracks: z.array(TimelineTrackSchema).describe('Multi-page scenes: one track per page, on the capture clock.').optional(),
    environment: TimelineEnvironmentSchema.optional(),
    warnings: z.array(z.string()),
  })
  .meta({
    id: 'Timeline',
    title: 'Retake timeline',
    description: 'runs/<id>/timeline.json: scenes, step events, markers, pages and cursor track in capture time.',
  }) satisfies z.ZodType<Timeline>;

/** What ran a capture (run.json `engine`): explains a difference between two machines' takes. */
const RunEngineSchema = z
  .strictObject({
    retake: nonEmpty().describe('Retake version.'),
    node: nonEmpty().describe('Node.js version.'),
    chromium: nonEmpty().describe('Version of the browser the run filmed with (absent when it did not open).').optional(),
    os: nonEmpty().describe('Platform, release and architecture, e.g. "darwin 25.6.0 arm64".'),
    fonts: z
      .strictObject({ files: z.number().int().min(0), digest: nonEmpty() })
      .describe('The fonts installed on the machine: the number of font files and a digest of their names.')
      .optional(),
  })
  .describe('What ran the capture: Retake, Node.js, Chromium, the OS and its installed fonts.');

const cpuSeconds = () => z.number().min(0);

/** run.json `perf` (L5.7): what the take cost and how smoothly it was filmed. */
const RunPerfSchema = z
  .strictObject({
    seconds: z.number().min(0).describe('Seconds of the take (capture time: its pauses left out).'),
    cpu: z
      .strictObject({
        browser: cpuSeconds(),
        gpu: cpuSeconds(),
        renderer: cpuSeconds(),
        chromium_other: cpuSeconds(),
        retake: cpuSeconds(),
        encoder: cpuSeconds(),
        product: cpuSeconds().optional(),
        total: cpuSeconds(),
        cores: z.number().min(0).describe('total / seconds: the cores the take kept busy on average.'),
        browsers: z
          .array(z.strictObject({ persona: z.string().optional(), cpu: cpuSeconds(), unfilmed: z.strictObject({ cpu: cpuSeconds(), seconds: z.number().min(0) }).optional() }))
          .describe('Per browser (one per persona): its CPU seconds, and while no recorder filmed it.')
          .optional(),
      })
      .describe('CPU seconds per process group over the take (Chromium browser / GPU / renderer / other, retake, encoder, product).')
      .optional(),
    machine: z.strictObject({ cpus: z.number().int().min(1), load_mean: z.number().min(0), load_max: z.number().min(0) }),
    gpu: z
      .strictObject({ accelerated: z.boolean(), renderer: z.string().optional(), software: z.array(z.string()).optional() })
      .describe("Chromium's own GPU feature report.")
      .optional(),
    frame_rate_limit: z.boolean(),
    frames: z.strictObject({
      received: z.number().int().min(0),
      fps: z.number().min(0),
      motion_fps_min: z.number().min(0).optional(),
      dropped: z.number().int().min(0),
      kicked: z.number().int().min(0),
    }),
    stalls: z.array(z.strictObject({ t: t(), ms: z.number().min(0), during: z.enum(['move', 'ripple']) })),
    transitions: z
      .strictObject({
        measured: z.number().int().min(0),
        slow: z.array(z.strictObject({ t: t(), ms: z.number().min(0), scene: z.string(), step: z.number().int(), target: z.string().optional() })),
      })
      .describe('Click → stable content: the clicks measured and the slow ones (over 800 ms), slowest first.')
      .optional(),
    live_preview: z
      .strictObject({ seconds: z.number().min(0), frames_sent: z.number().int().min(0) })
      .describe("The Studio's live picture watched during the take: the seconds its screencast ran, the frames it sent (L4.4).")
      .optional(),
    encode: z
      .strictObject({ codec: nonEmpty(), quality: z.string(), finish_ms: z.number().min(0), late_frames: z.number().int().min(0) })
      .optional(),
    disk: z.strictObject({ run_mb: z.number().min(0), frames_kept: z.boolean(), free_gb: z.number().min(0).optional() }).optional(),
  })
  .describe('What the take cost (CPU per process group, the machine, the GPU) and how smoothly it was filmed (frame rate, stalls, slow transitions).');

export const RunRecordSchema = z
  .strictObject({
    version: fileVersion(),
    id: nonEmpty(),
    project: nonEmpty(),
    scenario: nonEmpty(),
    mode: z.enum(['capture', 'dry']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    started_at: nonEmpty(),
    finished_at: z.string().optional(),
    dir: nonEmpty(),
    env: z.string(),
    options: z.strictObject({
      until: z.string().optional(),
      hooks: z.enum(['run', 'skip']),
      headed: z.boolean(),
      cursor: z.literal('hidden').optional(),
      allow_writes: z.literal(true).optional(),
    }),
    environment: z
      .strictObject({
        production: z.literal(true).optional(),
        access: z.enum(ENVIRONMENT_ACCESS),
        clock: z
          .strictObject({ at: nonEmpty(), timezone: z.string().optional(), freeze: z.literal(true).optional() })
          .describe('The product clock: as written, the zone a time without an offset is read in, frozen or not.')
          .optional(),
        sandbox: RunSandboxSchema.optional(),
      })
      .describe("The environment's safety: production, the run's effective access, the clock.")
      .optional(),
    steps_total: z.number().int().min(0),
    steps_done: z.number().int().min(0),
    current: z.strictObject({ scene: z.string(), step: z.number().int(), action: z.string() }).optional(),
    capture: z.string().optional(),
    timeline: z.string().optional(),
    screenshots: z.array(z.string()),
    hooks: z.strictObject({
      setup: z.enum(['ok', 'failed', 'skipped', 'none']),
      teardown: z.enum(['ok', 'failed', 'skipped', 'none']),
      steps: z.enum(['ok', 'failed', 'skipped']).describe('`hook:` steps (absent when the scenario has none).').optional(),
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
        missing_targets: z
          .array(
            z.strictObject({
              scene: z.string(),
              step: z.number().int(),
              action: z.string(),
              target: z.string(),
              near: z.array(z.strictObject({ role: z.string().optional(), name: z.string().optional(), text: z.string().optional() })),
            }),
          )
          .describe('A target was not found: the targets of the scene\'s later steps missing from the page too, with the closest visible elements.')
          .optional(),
      })
      .optional(),
    optional_failures: z
      .array(
        z.strictObject({
          scene: z.string(),
          step: z.number().int(),
          action: z.string(),
          error: z.string(),
          screenshot: z.string().optional(),
        }),
      )
      .describe('The optional steps that failed (the run went on).')
      .optional(),
    stopped_at: z
      .strictObject({ scene: z.string(), step: z.number().int(), reason: z.enum(['irreversible', 'until']) })
      .optional(),
    engine: RunEngineSchema.optional(),
    perf: RunPerfSchema.optional(),
    paused: z
      .strictObject({ scene: z.string(), step: z.number().int(), since: z.string() })
      .describe('The run is paused now (a run of a job), before this step.')
      .optional(),
    pauses: z
      .array(z.strictObject({ scene: z.string(), step: z.number().int(), at: z.string(), ms: z.number().int().min(0) }))
      .describe('The pauses the run had: before which step, when, how long.')
      .optional(),
  })
  .meta({ id: 'RunRecord', title: 'Retake run record', description: 'runs/<id>/run.json' }) satisfies z.ZodType<RunRecord>;
