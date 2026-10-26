/**
 * The job input contract (L3.1, ADR-1 amendment): what a client hands the jobs worker. Serialisable and validated here:
 * a project is a slug, a scenario a name with the sha256 of its bytes at submit (what was checked is what runs), a run a
 * pre-reserved id. Never a secret value, a session or an absolute path: the worker resolves `{{env:…}}` /
 * `{{keychain:…}}` references and persona sessions itself, from its own environment and ~/.demo-studio.
 */
import { z } from 'zod';
import { PROJECT_SLUG_RE } from './project.js';
import { inspectPathProblem, INSPECT_PATH_MAX } from './inspect.js';
import { RECORD_ID_RE } from './recording.js';
import { siteUrlProblem } from './site.js';
import { COMPONENT_ID_RE, ComponentRefSchema, FrameSpecSchema, KEY_RE, SLUG_RE, TargetSpecSchema, TransitionSchema, TutorialSwitchSchema } from './schemas/primitives.js';

export const JOB_INPUT_VERSION = 1;

/** queued → running → succeeded | failed | cancelled; `interrupted` is derived when reading (the worker died). */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Kinds of L3.1, `render`, `review`, `export`, `preview` (L3.2), `inspect` (L3.3), `record` (L3.4) and `site` (L3.5). */
export const JOB_KINDS = ['run', 'hooks', 'env_reset', 'auth_login', 'sandbox_up', 'sandbox_reset', 'render', 'review', 'export', 'preview', 'inspect', 'record', 'site'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Who submitted a job (recorded; shapes the safety rules applied at submit). `ui` (L4.1): the Studio web app, under the
 * agent's trust (the worker runs every job under trust `mcp` whoever submitted it).
 */
export const JOB_CLIENTS = ['mcp', 'cli', 'test', 'ui'] as const;
export type JobClient = (typeof JOB_CLIENTS)[number];

/** "j_" + 26 Crockford base32 characters (10 of time, 16 random): sortable by creation. */
export const JOB_ID_RE = /^j_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A folder name of runs/ ("20261017-142233-quote"). */
export const RUN_FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An environment name of project.yaml: a name, never a path. */
export const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A hooks source a job may name (never a path outside the project): `reset` (project.yaml), `<scenario>:setup` /
 * `<scenario>:teardown`, or a hooks file of the project's hooks/ folder.
 */
export const HOOKS_SOURCE_RE = /^(?:reset|[A-Za-z0-9][A-Za-z0-9_-]*:(?:setup|teardown)|hooks\/[A-Za-z0-9][A-Za-z0-9_-]*\.ya?ml)$/;

/** The body of SLUG_RE (a scenario name), to build ids made of one. */
const SLUG_BODY = SLUG_RE.source.replace(/^\^/, '').replace(/\$$/, '');
/**
 * A render id, the base name of renders/<id>.mp4 and .json: "<scenario>-v<N>", plus "-vertical" / "-square" for those
 * variants. Built from SLUG_RE: a scenario name may hold upper-case letters and "_".
 */
export const RENDER_ID_RE = new RegExp(`^${SLUG_BODY}-v\\d+(?:-vertical|-square)?$`);
/** A theme (template) name: a folder of the workspace's templates_dir or a starter template, never a path. */
export const TEMPLATE_NAME_RE = SLUG_RE;
/** A preview id, the folder <workspace>/.demo-studio/previews/<id>/: "p_" + 26 Crockford base32 characters. */
export const PREVIEW_ID_RE = /^p_[0-9A-HJKMNP-TV-Z]{26}$/;
/** An inspection id, the folder <project>/.demo-studio/inspect/<id>/: "i_" + 26 Crockford base32 characters. */
export const INSPECT_ID_RE = /^i_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A site extraction id, the folder <workspace>/.demo-studio/site/<id>/: "s_" + 26 Crockford base32 characters. */
export const SITE_ID_RE = /^s_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Targets an inspection checks, at most; elements it lists, at most. */
export const INSPECT_JOB_TARGETS_MAX = 20;
export const INSPECT_JOB_LIMIT_MAX = 300;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 (64 lower-case hex characters)');

/**
 * A human approval of one hook (L3.1, R-MCP-35), taken at submit (MCP elicitation) and written once with the job: the
 * fingerprint of the raw hook as its file declares it, with its phase, position and environment (@demo-studio/hooks
 * hookFingerprint). The worker runs a hook that needs approval only when its fingerprint is listed: a hook changed
 * between submit and run is refused.
 */
export const JobApprovalSchema = z.strictObject({
  fingerprint: sha256,
  /** Who approved: a human through the MCP client's elicitation, or a test. */
  by: z.enum(['human-elicitation', 'test']),
  at: z.string().max(40),
  /**
   * HMAC-SHA256 of the job input and the approval with the key of the studio home (engine signing.ts), added when the
   * job is queued: the worker ignores an approval without a valid one (a job file not written by a submit).
   */
  sig: sha256.optional(),
});
export type JobApproval = z.output<typeof JobApprovalSchema>;

const approvals = z.array(JobApprovalSchema).max(200).optional();
const projectSlug = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug, never a path');
const envName = z.string().max(100).regex(ENV_NAME_RE, 'an environment name, never a path');
/** A journal id of <project>/.demo-studio/journals/ (reserved at submit: `hooks-<label>` / `env-reset` run ids). */
const journalId = z.string().max(200).regex(RUN_FOLDER_RE, 'a journal id, never a path');

export const RunJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('run'),
  project: projectSlug,
  scenario: z.string().max(100).regex(SLUG_RE, 'a scenario name (scenarios/<name>.yaml), never a path'),
  /** sha256 of the scenario file's bytes at submit: the worker refuses to run other bytes. */
  scenario_sha256: sha256,
  mode: z.enum(['capture', 'dry']),
  env: envName.optional(),
  until: z.string().min(1).max(200).optional(),
  hooks: z.enum(['run', 'skip']).optional(),
  /** Reset the sandbox environment to its seed before the take. */
  sandbox: z.boolean().optional(),
  /** Reserved at submit (core reserveRunId): runs/<run_id>/run.json says `queued` until the worker starts it. */
  run_id: z.string().max(200).regex(RUN_FOLDER_RE, 'a run folder name, never a path'),
  submitted_by: z.enum(JOB_CLIENTS),
  approvals,
});

/** Hooks outside a capture (`studio hooks run`): describe and security-check them (dry), or run them with a journal. */
export const HooksJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('hooks'),
  project: projectSlug,
  source: z.string().max(120).regex(HOOKS_SOURCE_RE, 'reset, <scenario>:setup, <scenario>:teardown or hooks/<name>.yaml, never another path'),
  env: envName.optional(),
  /** Template and security-check only: nothing is executed, nothing journaled, no approval needed. */
  dry: z.boolean(),
  journal_id: journalId,
  submitted_by: z.enum(JOB_CLIENTS),
  approvals,
});

/** `studio env reset`: replay the pending rollbacks of every journal, then the project's `reset` hooks. */
export const EnvResetJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('env_reset'),
  project: projectSlug,
  env: envName.optional(),
  dry: z.boolean(),
  journal_id: journalId,
  submitted_by: z.enum(JOB_CLIENTS),
  approvals,
});

/** A persona of project.yaml `auth.<env>.personas` (a name, never a path or a credential). */
const personaName = z.string().max(100).regex(SLUG_RE, 'a persona name of project.yaml, never a path');

/**
 * `studio login`: sign one persona in and save its session in the worker's ~/.demo-studio. `headed` opens a visible
 * window on the machine the worker runs on, for a HUMAN to sign in (the job waits until the window is closed); `auto`
 * plays the persona's `login:` steps of project.yaml, headless. A job never carries a credential: there is no field for
 * one, and the steps' `{{env:…}}` / `{{keychain:…}}` refs are resolved by the worker.
 */
export const AuthLoginJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('auth_login'),
  project: projectSlug,
  env: envName.optional(),
  /** Omitted: the environment's only persona. */
  persona: personaName.optional(),
  mode: z.enum(['headed', 'auto']),
  submitted_by: z.enum(JOB_CLIENTS),
  approvals,
});

/**
 * `studio sandbox up`: start what is not running, health, and seed when needed. Seed steps of a job run with trust
 * `mcp`: a shell seed step needs a human approval (`approvals`), like a hook.
 */
export const SandboxUpJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('sandbox_up'),
  project: projectSlug,
  /** The sandbox environment (default: the first of project.yaml `sandboxes`). */
  env: envName.optional(),
  submitted_by: z.enum(JOB_CLIENTS),
  approvals,
});

/** `studio sandbox reset`: back to the seed (the sandbox must be up). Seed steps as for `sandbox_up`. */
export const SandboxResetJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('sandbox_reset'),
  project: projectSlug,
  env: envName.optional(),
  /** Run the seed even when a snapshot could be restored. */
  reseed: z.boolean().optional(),
  submitted_by: z.enum(JOB_CLIENTS),
  approvals,
});

/** A file of the project named relative to its folder (checked again, symbolic links resolved, by agent-trust). */
const projectFileRef = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !s.includes('\0') && !/^(?:[\\/]|~|[A-Za-z]:)/.test(s) && !s.split(/[\\/]/).includes('..'), 'a file of the project folder, relative to it (no absolute path, no "..")');
/** A scene or segment id of a timeline ("intro", "<scene id>", "interstitial-3"). */
const segmentKey = z.string().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'a scene id, a segment id or a component kind');

/**
 * The edit overrides a client may pass with a render (the editor's EditOverrides, minus `theme`: a render job names
 * its theme in `template`). Bounded and strict: unknown keys are refused, a music file is a project file.
 */
export const EditOverridesInputSchema = z.strictObject({
  frame: FrameSpecSchema.optional(),
  variant: z.enum(['landscape', 'vertical', 'square']).optional(),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional(),
  scale: z.number().min(0.5).max(2).optional(),
  intro: z.boolean().optional(),
  outro: z.boolean().optional(),
  captions: z.boolean().optional(),
  camera: z.boolean().optional(),
  trim_idle: z.boolean().optional(),
  idle_threshold: z.number().min(0.3).max(10).optional(),
  speeds: z
    .record(segmentKey, z.number().min(0.25).max(4))
    .refine((r) => Object.keys(r).length <= 100, 'at most 100 scenes')
    .optional(),
  transition: TransitionSchema.optional(),
  transition_duration: z.number().min(0).max(2).optional(),
  components: z
    .record(segmentKey, ComponentRefSchema)
    .refine((r) => Object.keys(r).length <= 50, 'at most 50 component switches')
    .refine((r) => JSON.stringify(r).length <= 8192, 'component switches of at most 8 KB')
    .optional(),
  music: z.union([projectFileRef, z.literal(false)]).optional(),
  tutorial: TutorialSwitchSchema.optional(),
});
export type EditOverridesInput = z.output<typeof EditOverridesInputSchema>;

const scenarioName = z.string().max(100).regex(SLUG_RE, 'a scenario name (scenarios/<name>.yaml), never a path');
export const templateNameSchema = z.string().max(100).regex(TEMPLATE_NAME_RE, 'a theme (template) name, never a path');
export const renderIdSchema = z.string().max(200).regex(RENDER_ID_RE, 'a render id such as quote-v3 (renders/<id>.json), never a path');

/**
 * A render (L3.2): plan the run's capture with the theme and overrides, then render it with Remotion in the worker
 * (renders/<render_id>.mp4 + .json). The render id is reserved at submit (a `.<scenario>-v<N>.lock` of renders/); the
 * worker re-plans and refuses a timeline or a variant that changed since.
 */
export const RenderJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('render'),
  project: projectSlug,
  scenario: scenarioName,
  /** The capture run rendered (resolved at submit: never `latest`). */
  run_id: z.string().max(200).regex(RUN_FOLDER_RE, 'a run folder name, never a path'),
  /** sha256 of the run's timeline.json at submit. */
  timeline_sha256: sha256,
  /** L5.5: sha256 of the scenario file the edit was planned from at submit (absent: the run as captured). */
  edit_sha256: sha256.optional(),
  render_id: renderIdSchema,
  /** Theme for this render instead of the run's (a name, never a path). */
  template: templateNameSchema.optional(),
  overrides: EditOverridesInputSchema,
  submitted_by: z.enum(JOB_CLIENTS),
});

/**
 * A review (L3.2): contact sheets, key frames, checks and report of a render, written to review/<render_id>/ by the
 * worker. The render is named by its id (resolved at submit: never `latest`, never a path).
 */
export const ReviewJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('review'),
  project: projectSlug,
  render_id: renderIdSchema,
  /** Contact sheet rate. */
  fps: z.union([z.literal(1), z.literal(2)]),
  /** The render compared with: an id, or false for none; absent: the previous render of the same scenario and variant. */
  previous: z.union([renderIdSchema, z.literal(false)]).optional(),
  submitted_by: z.enum(JOB_CLIENTS),
});

/** Delivery formats of an export (the editor's EXPORT_FORMATS). */
export const EXPORT_FORMAT_NAMES = ['mp4_1080p', 'mp4_4k', 'webm', 'vertical_9x16', 'square_1x1', 'gif_preview'] as const;

/**
 * An export (L3.2): delivery files of a render in exports/<render_id>/ (+ manifest.json), transcoded from the master or
 * re-rendered (vertical, square, 4K) by the worker under the trust rules of a render job. No output location: the
 * folder is fixed.
 */
export const ExportJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('export'),
  project: projectSlug,
  render_id: renderIdSchema,
  formats: z
    .array(z.enum(EXPORT_FORMAT_NAMES))
    .min(1)
    .max(EXPORT_FORMAT_NAMES.length)
    .refine((f) => new Set(f).size === f.length, 'each format once'),
  /** The GIF preview's window (seconds of the master; at most 30 s). */
  gif: z.strictObject({ start_s: z.number().min(0).max(3600).optional(), duration_s: z.number().min(0.5).max(30).optional() }).optional(),
  submitted_by: z.enum(JOB_CLIENTS),
});

/** A component preview: one component of the registry, with slot values and params instead of its manifest's samples. */
const PreviewComponentTargetSchema = z.strictObject({
  kind: z.literal('component'),
  component: z.string().max(120).regex(COMPONENT_ID_RE, 'a component id such as studio/intro-stack (component_list names them), never a path'),
  /** Text slots (text, url, color) instead of the manifest's preview samples; file and media slots keep their samples. */
  slots: z
    .record(z.string().max(60).regex(KEY_RE, 'a slot name of the component'), z.string().max(2000))
    .refine((r) => Object.keys(r).length <= 30, 'at most 30 slots')
    .optional(),
  /** Params (validated against the component's params schema), over its preview params and defaults. */
  params: z
    .record(z.string().max(60), z.unknown())
    .refine((r) => JSON.stringify(r).length <= 8192, 'params of at most 8 KB')
    .optional(),
  /** Second of the component shown (default: its manifest's preview moment). */
  at_s: z.number().min(0).max(600).optional(),
});

/** A theme preview: the theme's own pick of intro, layout (with its caption over a sample screen), card, interstitial, outro. */
const PreviewThemeTargetSchema = z.strictObject({ kind: z.literal('theme') });

/**
 * A preview (L3.2): stills of a component or of a theme, rendered by the worker (guarded, like a render) into
 * <workspace>/.demo-studio/previews/<preview_id>/ — never into a component folder (preview.png of the library and of
 * workspace components stay a `studio components preview` matter). No output location: the folder is fixed.
 */
export const PreviewJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('preview'),
  /** The project whose theme is the default (and whose project.yaml may name its own theme folder). */
  project: projectSlug,
  preview_id: z.string().regex(PREVIEW_ID_RE, 'a preview id (p_ followed by 26 characters), never a path'),
  target: z.discriminatedUnion('kind', [PreviewComponentTargetSchema, PreviewThemeTargetSchema]),
  /** Theme of the previews (a name, never a path); absent: the project's own theme. */
  template: templateNameSchema.optional(),
  submitted_by: z.enum(JOB_CLIENTS),
});

/**
 * A target an inspection is given (`within`, `targets`): the scenario language's target, bounded, with no `{{…}}`
 * template anywhere (no `{{env:}}` / `{{keychain:}}` reaches the page through an inspection).
 */
export const InspectTargetSchema = TargetSpecSchema.refine((t) => JSON.stringify(t).length <= 2000, 'a target of at most 2000 characters').refine(
  (t) => !JSON.stringify(t).includes('{{'),
  'a target may not contain a {{…}} template',
);

/** A path opened under an environment page (core inspectPathProblem). */
const inspectPath = z
  .string()
  .max(INSPECT_PATH_MAX)
  .superRefine((p, ctx) => {
    const problem = inspectPathProblem(p);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/**
 * An inspection (L3.3, R-MCP-23): a dry replay — of a one-scene scenario opening `path` on the environment page `page`,
 * or of a saved scenario (its bytes' sha256 at submit) up to `until` — then the page it shows inventoried for an author
 * into <project>/.demo-studio/inspect/<inspect_id>/ (inspect.json, screenshot.png, marked.jpg). Run_dry semantics: the
 * environment's own access, hooks never run, production read-only. No URL: a URL given to the client is resolved at
 * submit to a page key and a path of the environment (same origin), and the runner re-checks the page's final origin.
 */
export const InspectJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('inspect'),
  project: projectSlug,
  inspect_id: z.string().regex(INSPECT_ID_RE, 'an inspection id (i_ followed by 26 characters), never a path'),
  env: envName.optional(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('page'),
      page: z.string().max(100).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'an environment page key of project.yaml, never a URL or a path'),
      path: inspectPath,
      /** The persona the page is signed in as (`none`: signed out); default the persona whose `pages` list it. */
      persona: personaName.optional(),
    }),
    z.strictObject({
      kind: z.literal('scenario'),
      scenario: scenarioName,
      scenario_sha256: sha256,
      until: z.string().min(1).max(200).refine((s) => !s.includes('{{'), 'no {{…}} template').optional(),
    }),
  ]),
  within: InspectTargetSchema.optional(),
  targets: z.array(InspectTargetSchema).max(INSPECT_JOB_TARGETS_MAX).optional(),
  limit: z.number().int().min(1).max(INSPECT_JOB_LIMIT_MAX).optional(),
  /** `marked`: a JPEG with a numbered box per listed element in view (marked.jpg); `none`: the plain screenshot only. */
  images: z.enum(['marked', 'none']),
  submitted_by: z.enum(JOB_CLIENTS),
});

/**
 * A recording (L3.4, R-MCP-24): a HEADED browser window opens on the machine the worker runs on, at `path` of the
 * environment page `page`, for a HUMAN to perform a flow and close the window — the job waits for it (it holds the queue
 * like a headed sign-in; at most DEMO_STUDIO_RECORD_MAX_MIN, default 30 min). Nobody drives the window through the job:
 * no field carries a step, a URL or typed text. A draft scenario is made from what the person did, saved as
 * scenarios/<scenario>.yaml when the name is free (under agent trust), and checked by a headless dry replay. The
 * recording's folder <project>/.demo-studio/records/<rec_id>/ is reserved by its id at submit. The environment's own
 * access (production read-only: writes stopped or mocked), never --allow-writes; hooks never run.
 */
export const RecordJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('record'),
  project: projectSlug,
  rec_id: z.string().regex(RECORD_ID_RE, 'a recording id (rec_ followed by 26 characters), never a path'),
  env: envName.optional(),
  /** The page the window opens: an environment page key and a path under it. */
  source: z.strictObject({
    page: z.string().max(100).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'an environment page key of project.yaml, never a URL or a path'),
    path: inspectPath,
  }),
  /** The persona the window is signed in as (`none`: signed out); default the persona whose `pages` list the page. */
  persona: personaName.optional(),
  /** The draft's name (default recorded-YYYYMMDD-HHMM); saved only when free. */
  scenario: scenarioName.optional(),
  /** The headless check replay after the recording. */
  check: z.boolean(),
  submitted_by: z.enum(JOB_CLIENTS),
});

/**
 * A site extraction (L3.5, R-MCP-12): a clean ephemeral browser opens `url` through the worker's CONNECT proxy (public
 * addresses only, GET / HEAD only, caps) and the page's colours, font family names, logo candidates (made PNG by the
 * worker) and a screenshot are written to <workspace>/.demo-studio/site/<site_id>/. Workspace-level: no project.
 * A job of this kind runs ONLY with a human's approval of exactly this URL, signed at submit (engine signing.ts):
 * fingerprint sha256("site\n" + canonical href). The CLI never queues one (`studio theme from-site` runs in-process),
 * so the worker refuses the whole job without it, whoever `submitted_by` names.
 */
export const SiteJobInputSchema = z.strictObject({
  version: z.literal(JOB_INPUT_VERSION),
  kind: z.literal('site'),
  site_id: z.string().regex(SITE_ID_RE, 'a site extraction id (s_ followed by 26 characters), never a path'),
  /** The canonical URL (core parseSiteUrl): https, default port, no userinfo, query or fragment. */
  url: z
    .string()
    .max(300)
    .superRefine((u, ctx) => {
      const problem = siteUrlProblem(u);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  submitted_by: z.enum(JOB_CLIENTS),
  approvals,
});

export const JobInputSchema = z.discriminatedUnion('kind', [
  RunJobInputSchema,
  HooksJobInputSchema,
  EnvResetJobInputSchema,
  AuthLoginJobInputSchema,
  SandboxUpJobInputSchema,
  SandboxResetJobInputSchema,
  RenderJobInputSchema,
  ReviewJobInputSchema,
  ExportJobInputSchema,
  PreviewJobInputSchema,
  InspectJobInputSchema,
  RecordJobInputSchema,
  SiteJobInputSchema,
]);

export type RunJobInput = z.output<typeof RunJobInputSchema>;
export type HooksJobInput = z.output<typeof HooksJobInputSchema>;
export type EnvResetJobInput = z.output<typeof EnvResetJobInputSchema>;
export type AuthLoginJobInput = z.output<typeof AuthLoginJobInputSchema>;
export type SandboxUpJobInput = z.output<typeof SandboxUpJobInputSchema>;
export type SandboxResetJobInput = z.output<typeof SandboxResetJobInputSchema>;
export type RenderJobInput = z.output<typeof RenderJobInputSchema>;
export type ReviewJobInput = z.output<typeof ReviewJobInputSchema>;
export type ExportJobInput = z.output<typeof ExportJobInputSchema>;
export type PreviewJobInput = z.output<typeof PreviewJobInputSchema>;
export type InspectJobInput = z.output<typeof InspectJobInputSchema>;
export type RecordJobInput = z.output<typeof RecordJobInputSchema>;
export type SiteJobInput = z.output<typeof SiteJobInputSchema>;
export type ExportFormatName = (typeof EXPORT_FORMAT_NAMES)[number];
export type JobInput = z.output<typeof JobInputSchema>;
