import { z } from 'zod';
import { SLUG_RE } from '@retake/core';
import { OPERATIONS_BY_NAME, runOutput, waitJob, waitS } from '@retake/engine/contract';
import { envName, projectSlug, scenarioName } from '../schema.js';
import { RUN_JOB, defineTool } from './define.js';
import type { ToolDef } from './define.js';

const { run_list: runList, run_status: runStatus, run_cancel: runCancel } = OPERATIONS_BY_NAME;

const runInput = {
  project: projectSlug,
  scenario: scenarioName,
  env: envName.optional().describe('Environment (default: the scenario\'s env, else the project\'s default_env). Production environments always run read-only here.'),
};

export const runDry = defineTool({
  name: 'run_dry',
  title: 'Dry-run a scenario',
  description:
    'Run a scenario without recording, to check it: every step runs in a headless browser against the environment (irreversible steps and the scenario\'s setup / teardown hooks are skipped unless hooks: "run"), with one screenshot per step, then the run stops. A job runs it in the background (refused while a run of the scenario is queued or running); this call waits up to wait_s (default 20) and returns the run as it is then (run_status follows it). On a failure: the scene, step, error screenshot and DOM snapshot paths. until stops after that step (scene.step, a step id or a scene id).',
  input: z.strictObject({
    ...runInput,
    until: z.string().min(1).max(200).optional().describe('Stop after this step: <scene>.<step id or index>, a unique step id, or a scene id.'),
    hooks: z
      .enum(['run', 'skip'])
      .optional()
      .describe('"run" executes the setup / teardown hooks too (default skip). Hooks that are destructive or run shell commands need a human: the user is asked to approve them (else the call is refused with the command a human runs).'),
    wait_s: waitS(20, 'the dry run to finish'),
  }),
  annotations: RUN_JOB,
  async run({ project, scenario, env, until, hooks, wait_s }, ctx) {
    const { engine } = ctx;
    const sub = await engine.runs.submit({ project, scenario, mode: 'dry', env, until, hooks }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    await waitJob(engine, sub.job, wait_s, ctx);
    return runOutput(engine, project, sub.run_id, [`dry run ${sub.run_id} submitted (job ${sub.job.id}).`, ...sub.warnings.map((w) => `warning: ${w}`)]);
  },
});

export const runCapture = defineTool({
  name: 'run_capture',
  title: 'Capture a scenario',
  description:
    'Capture a scenario: its setup hooks, every scene filmed in a headless browser (capture.mp4 + timeline.json), its teardown and rollbacks. A job runs it in the background (one capture at a time; renders, reviews and exports wait or yield while it films; refused while a run of the scenario is queued or running); this call returns at once (or waits up to wait_s) with the run id — follow it with run_status {wait_s}, stop it with run_cancel. sandbox: true resets the sandbox environment to its seed first. Setup / teardown hooks that are destructive or run shell commands need a human: the user is asked to approve them before anything is queued ("confirm: true" in the file does not count here); a decline, or a client that cannot ask, refuses the call with the command a human runs. A persona whose saved session is not valid (expired, error, never signed in) and that no run signs in by itself refuses the call (conflict, details.sessions) until sessions_ack names it: tell the user, who signs in (auth_login) or confirms the capture.',
  input: z.strictObject({
    ...runInput,
    sandbox: z.boolean().optional().describe('Reset the sandbox environment (sandbox.yaml) to its seed before the take: up if needed, health, reset.'),
    sessions_ack: z
      .array(z.string().max(100).regex(SLUG_RE, 'a persona name'))
      .max(50)
      .optional()
      .describe('The personas whose session is not valid that the user confirms capturing with anyway (a refusal\'s details.sessions names them; the run still checks each one it can before filming).'),
    wait_s: waitS(0, 'the capture to finish'),
  }),
  annotations: RUN_JOB,
  async run({ project, scenario, env, sandbox, sessions_ack, wait_s }, ctx) {
    const { engine } = ctx;
    const sub = await engine.runs.submit({ project, scenario, mode: 'capture', env, sandbox, ...(sessions_ack ? { sessions_ack } : {}) }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    await waitJob(engine, sub.job, wait_s, ctx);
    return runOutput(engine, project, sub.run_id, [`capture ${sub.run_id} submitted (job ${sub.job.id}).`, ...sub.warnings.map((w) => `warning: ${w}`)]);
  },
});

export const RUN_TOOLS = [runList, runStatus, runDry, runCapture, runCancel] as const satisfies readonly ToolDef[];
