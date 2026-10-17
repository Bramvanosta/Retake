/**
 * The job input contract (L3.1, ADR-1 amendment): what a client hands the jobs worker. Serialisable and validated here:
 * a project is a slug, a scenario a name with the sha256 of its bytes at submit (what was checked is what runs), a run a
 * pre-reserved id. Never a secret value, a session or an absolute path: the worker resolves `{{env:…}}` /
 * `{{keychain:…}}` references and persona sessions itself, from its own environment and ~/.demo-studio.
 */
import { z } from 'zod';
import { PROJECT_SLUG_RE } from './project.js';
import { SLUG_RE } from './schemas/primitives.js';

export const JOB_INPUT_VERSION = 1;

/** queued → running → succeeded | failed | cancelled; `interrupted` is derived when reading (the worker died). */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Kinds of L3.1 (render / review / export follow in L3.2). */
export const JOB_KINDS = ['run', 'hooks', 'env_reset', 'auth_login', 'sandbox_up', 'sandbox_reset'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Who submitted a job (recorded; shapes the safety rules applied at submit). */
export const JOB_CLIENTS = ['mcp', 'cli', 'test'] as const;
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

export const JobInputSchema = z.discriminatedUnion('kind', [
  RunJobInputSchema,
  HooksJobInputSchema,
  EnvResetJobInputSchema,
  AuthLoginJobInputSchema,
  SandboxUpJobInputSchema,
  SandboxResetJobInputSchema,
]);

export type RunJobInput = z.output<typeof RunJobInputSchema>;
export type HooksJobInput = z.output<typeof HooksJobInputSchema>;
export type EnvResetJobInput = z.output<typeof EnvResetJobInputSchema>;
export type AuthLoginJobInput = z.output<typeof AuthLoginJobInputSchema>;
export type SandboxUpJobInput = z.output<typeof SandboxUpJobInputSchema>;
export type SandboxResetJobInput = z.output<typeof SandboxResetJobInputSchema>;
export type JobInput = z.output<typeof JobInputSchema>;
