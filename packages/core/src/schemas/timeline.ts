import { z } from 'zod';
import { ACTION_NAMES, CURSOR_ICONS, ENVIRONMENT_ACCESS, SANDBOX_PROVIDERS, SANDBOX_RESET_STRATEGIES } from '../types.js';
import type { Timeline } from '../types.js';
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

const LoadingUiSchema = z.strictObject({
  t_start: z.number(),
  t_end: z.number(),
  what: z.string().describe('Their kinds, e.g. "skeleton ×6".'),
  page: z.string().optional(),
});

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
    loading_ui: z.array(LoadingUiSchema).describe('Loading indicators (skeleton, shimmer, spinner, aria-busy) in the filmed page\'s viewport, as the take probed it.').optional(),
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

// ── run.json ─────────────────────────────────────────────────────────────────
// The shapes are written once and built twice (`runRecordSchemas`): strict objects for what this version writes
// (RunRecordSchema: an unknown key is an error), loose ones for what any version left on a disk
// (StoredRunRecordSchema: unknown keys pass at every level, and the two diagnostic blocks ask for less).

/** The object constructor the shapes are built with: `z.strictObject`, or `z.looseObject` under the same type. */
type ObjectOf = typeof z.strictObject;
/**
 * `z.looseObject` typed as the strict constructor: the stored schemas take unknown keys at run time and their types
 * name the known members only (StoredRunRecord has no index signature — a member this build does not know is never
 * read by name).
 */
const looseObject = z.looseObject as unknown as ObjectOf;

const cpuSeconds = () => z.number().min(0);

/** What ran a capture (run.json `engine`): explains a difference between two machines' takes. */
const runEngineSchema = (object: ObjectOf) =>
  object({
    retake: nonEmpty().describe('Retake version.'),
    node: nonEmpty().describe('Node.js version.'),
    chromium: nonEmpty().describe('Version of the browser the run filmed with (absent when it did not open).').optional(),
    os: nonEmpty().describe('Platform, release and architecture, e.g. "darwin 25.6.0 arm64".'),
    fonts: object({ files: z.number().int().min(0), digest: nonEmpty() })
      .describe('The fonts installed on the machine: the number of font files and a digest of their names.')
      .optional(),
  }).describe('What ran the capture: Retake, Node.js, Chromium, the OS and its installed fonts.');

/** run.json `perf` (L5.7): what the take cost and how smoothly it was filmed. `retake`: the schema of `cpu.retake`. */
const runPerfSchema = <C extends z.ZodType>(object: ObjectOf, retake: C) =>
  object({
    seconds: z.number().min(0).describe('Seconds of the take (capture time: its pauses left out).'),
    cpu: object({
      browser: cpuSeconds(),
      gpu: cpuSeconds(),
      renderer: cpuSeconds(),
      chromium_other: cpuSeconds(),
      retake,
      encoder: cpuSeconds(),
      product: cpuSeconds().optional(),
      total: cpuSeconds(),
      cores: z.number().min(0).describe('total / seconds: the cores the take kept busy on average.'),
      browsers: z
        .array(object({ persona: z.string().optional(), cpu: cpuSeconds(), unfilmed: object({ cpu: cpuSeconds(), seconds: z.number().min(0) }).optional() }))
        .describe('Per browser (one per persona): its CPU seconds, and while no recorder filmed it.')
        .optional(),
    })
      .describe('CPU seconds per process group over the take (Chromium browser / GPU / renderer / other, retake, encoder, product).')
      .optional(),
    machine: object({ cpus: z.number().int().min(1), load_mean: z.number().min(0), load_max: z.number().min(0), takes_beside: z.number().int().min(0).optional(), heavy_slowed: z.literal(true).optional() }),
    gpu: object({ accelerated: z.boolean(), renderer: z.string().optional(), software: z.array(z.string()).optional() })
      .describe("Chromium's own GPU feature report.")
      .optional(),
    frame_rate_limit: z.boolean(),
    frames: object({
      received: z.number().int().min(0),
      fps: z.number().min(0),
      motion_fps_min: z.number().min(0).optional(),
      dropped: z.number().int().min(0),
      kicked: z.number().int().min(0),
    }),
    stalls: z.array(object({ t: t(), ms: z.number().min(0), during: z.enum(['move', 'ripple']) })),
    transitions: object({
      measured: z.number().int().min(0),
      slow: z.array(object({ t: t(), ms: z.number().min(0), scene: z.string(), step: z.number().int(), target: z.string().optional() })),
    })
      .describe('Click → stable content: the clicks measured and the slow ones (over 800 ms), slowest first.')
      .optional(),
    live_preview: object({ seconds: z.number().min(0), frames_sent: z.number().int().min(0) })
      .describe("The Studio's live picture watched during the take: the seconds its screencast ran, the frames it sent (L4.4).")
      .optional(),
    encode: object({ codec: nonEmpty(), quality: z.string(), finish_ms: z.number().min(0), late_frames: z.number().int().min(0) }).optional(),
    disk: object({ run_mb: z.number().min(0), frames_kept: z.boolean(), free_gb: z.number().min(0).optional() }).optional(),
  }).describe('What the take cost (CPU per process group, the machine, the GPU) and how smoothly it was filmed (frame rate, stalls, slow transitions).');

/** A member a state never has: absent (a value there is an error, in the strict and in the loose build). */
const never = () => z.never().optional();

/**
 * The run record's states, built with `object`: one schema per status — what each state has, and what it never has —
 * and `unknown`, the same members under a status that is any text (a record whose status Retake never writes).
 * `blocks`: the schemas of the two diagnostic blocks and of the sandbox.
 */
function runRecordSchemas<E extends z.ZodType, P extends z.ZodType, S extends z.ZodType>(object: ObjectOf, blocks: { engine: E; perf: P; sandbox: S }, lax = false) {
  // The stored build reads the members that decide nothing leniently (`lax`): a closed word is any text, a flag any
  // boolean, a count any number, a text may be empty — a value a later version writes there is kept as the file holds
  // it. What decides a record's state (its status and what that state has or never has), its scenario, its kind and
  // its id are the same in both builds. The lax schemas keep the strict ones' static types (the casts below): the
  // type a stored record is read as is core run-record.ts's StoredRunRecord, which says text where these take text.
  const word = <const T extends readonly [string, ...string[]]>(values: T) => (lax ? (z.string() as unknown as z.ZodEnum<{ [K in T[number]]: K }>) : z.enum(values));
  const flag = () => (lax ? (z.boolean() as unknown as z.ZodLiteral<true>) : z.literal(true));
  const hidden = () => (lax ? (z.string() as unknown as z.ZodLiteral<'hidden'>) : z.literal('hidden'));
  const count = () => (lax ? z.number() : z.number().int().min(0));
  const whole = () => (lax ? z.number() : z.number().int());
  const text = () => (lax ? z.string() : nonEmpty());
  const base = {
    version: fileVersion(),
    id: nonEmpty(),
    project: text(),
    scenario: nonEmpty(),
    mode: z.enum(['capture', 'dry']),
    started_at: text(),
    dir: text(),
    env: z.string(),
    options: object({
      until: z.string().optional(),
      hooks: word(['run', 'skip']),
      headed: z.boolean(),
      cursor: hidden().optional(),
      allow_writes: flag().optional(),
    }),
    environment: object({
      production: flag().optional(),
      access: word(ENVIRONMENT_ACCESS),
      clock: object({ at: text(), timezone: z.string().optional(), freeze: flag().optional() })
        .describe('The product clock: as written, the zone a time without an offset is read in, frozen or not.')
        .optional(),
      sandbox: blocks.sandbox.optional(),
    })
      .describe("The environment's safety: production, the run's effective access, the clock.")
      .optional(),
    steps_total: count(),
    steps_done: count(),
    screenshots: z.array(z.string()),
    hooks: object({
      setup: word(['ok', 'failed', 'skipped', 'none']),
      teardown: word(['ok', 'failed', 'skipped', 'none']),
      steps: word(['ok', 'failed', 'skipped']).describe('`hook:` steps (absent when the scenario has none).').optional(),
    }),
    warnings: z.array(z.string()),
    optional_failures: z
      .array(object({ scene: z.string(), step: whole(), action: z.string(), error: z.string(), screenshot: z.string().optional() }))
      .describe('The optional steps that failed (the run went on).')
      .optional(),
    stopped_at: object({ scene: z.string(), step: whole(), reason: word(['irreversible', 'until']) }).optional(),
    engine: blocks.engine.optional(),
    perf: blocks.perf.optional(),
    pauses: z
      .array(object({ scene: z.string(), step: whole(), at: z.string(), ms: count() }))
      .describe('The pauses the run had: before which step, when, how long.')
      .optional(),
  };
  const error = object({
    message: z.string(),
    scene: z.string().optional(),
    step: whole().optional(),
    action: z.string().optional(),
    screenshot: z.string().optional(),
    dom: z.string().optional(),
    missing_targets: z
      .array(
        object({
          scene: z.string(),
          step: whole(),
          action: z.string(),
          target: z.string(),
          near: z.array(object({ role: z.string().optional(), name: z.string().optional(), text: z.string().optional() })),
        }),
      )
      .describe('A target was not found: the targets of the scene\'s later steps missing from the page too, with the closest visible elements.')
      .optional(),
  });
  const current = object({ scene: z.string(), step: whole(), action: z.string() });
  const paused = object({ scene: z.string(), step: whole(), since: z.string() }).describe('The run is paused now (a run of a job), before this step.');
  /** Where a run is, or was when it was closed from outside, and what it had filmed by then. */
  const inFlight = { current: current.optional(), paused: paused.optional(), capture: z.string().optional(), timeline: z.string().optional() };
  return {
    queued: object({ ...base, status: z.literal('queued'), finished_at: never(), error: never(), current: never(), paused: never(), capture: never(), timeline: never() }),
    running: object({ ...base, status: z.literal('running'), ...inFlight, finished_at: never(), error: never() }),
    succeeded: object({ ...base, status: z.literal('succeeded'), finished_at: z.string(), capture: z.string().optional(), timeline: z.string().optional(), error: never(), current: never(), paused: never() }),
    failed: object({ ...base, status: z.literal('failed'), finished_at: z.string(), error, ...inFlight }),
    cancelled: object({ ...base, status: z.literal('cancelled'), finished_at: z.string(), error, ...inFlight }),
    unknown: object({ ...base, status: z.string(), finished_at: z.string().optional(), error: error.optional(), ...inFlight }),
  };
}

const written = runRecordSchemas(z.strictObject, { engine: runEngineSchema(z.strictObject), perf: runPerfSchema(z.strictObject, cpuSeconds()), sandbox: RunSandboxSchema });

/**
 * run.json as this version writes it: one state per status (a succeeded run has no error and no current step, a
 * finished one has its end, a queued one nothing of a run), unknown keys refused. Its twin types are core
 * run-record.ts's (schemas/type-checks.ts holds them together).
 */
export const RunRecordSchema = z
  .discriminatedUnion('status', [written.queued, written.running, written.succeeded, written.failed, written.cancelled])
  .meta({ id: 'RunRecord', title: 'Retake run record', description: 'runs/<id>/run.json' });

/** run.json `engine` as any version left it: every member optional, unknown keys kept. */
export const StoredRunEngineSchema = runEngineSchema(looseObject).partial();
/** run.json `perf` as any version left it: `cpu.retake` optional, unknown keys kept at every level. */
export const StoredRunPerfSchema = runPerfSchema(looseObject, cpuSeconds().optional());

/** The sandbox block as any version left it: its name, and whatever else it holds (a provider or a strategy a later version names is kept). */
const storedSandbox = z.looseObject({ name: z.string() }) as unknown as typeof RunSandboxSchema;

const stored = runRecordSchemas(looseObject, { engine: StoredRunEngineSchema, perf: StoredRunPerfSchema, sandbox: storedSandbox }, true);

/**
 * run.json as any version left it on a disk: the same states, unknown keys kept at every level, the diagnostic blocks
 * asking for less (core run-record.ts `parseRunRecord` is the reader: it drops a block that does not read).
 */
export const StoredRunRecordSchema = z.discriminatedUnion('status', [stored.queued, stored.running, stored.succeeded, stored.failed, stored.cancelled]);

/** The stored schema of each state, and `unknown`: the same members under a status that is any text (for the reader's lenient pass). */
export const StoredRunStateSchemas = stored;

/** A stored record whose status is any text: what a record of an unknown status must still hold to be shown. */
export const UnknownStatusRunSchema = stored.unknown;
