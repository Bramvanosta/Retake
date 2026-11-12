import { z } from 'zod';
import { OPERATIONS_BY_NAME, jobOutput, waitS } from '@retake/engine/contract';
import { envName, projectSlug } from '../schema.js';
import { READ, SANDBOX_JOB, defineTool } from './define.js';
import type { ToolDef } from './define.js';

const { auth_status: authStatus, auth_login: authLogin } = OPERATIONS_BY_NAME;

export const sandboxStatus = defineTool({
  name: 'sandbox_status',
  title: 'Status of a sandbox',
  description:
    'A sandbox environment of a project (sandbox.yaml): up / partial / down, its services (running, healthy), pages, last seed and reset, and the take lock. It starts nothing.',
  input: z.strictObject({
    project: projectSlug,
    env: envName.optional().describe('The sandbox environment (default: the first of project.yaml sandboxes).'),
  }),
  annotations: READ,
  async run({ project, env }, { engine }) {
    const s = await engine.sandbox.status(project, env);
    const services = s.services.map((x) => `${x.name} ${x.state}${x.healthy === false ? ' (not healthy)' : x.healthy ? ' (healthy)' : ''}`).join(', ');
    return {
      summary: [
        `sandbox ${s.env} of ${project} (${s.provider}): ${s.state}${services ? ` — ${services}` : ''}`,
        s.seed ? `seed ${s.seed.hash}${s.seed.current ? '' : ' (sandbox.yaml changed since: the next up or reset seeds again)'}` : 'never seeded',
        s.lock ? `in use by: ${s.lock.command}` : 'take lock: free',
        ...(s.state !== 'up' ? [`start it: sandbox_up {project: "${project}", env: "${s.env}"}`] : []),
      ].join('\n'),
      data: s,
    };
  },
});

const sandboxEnv = envName.optional().describe('The sandbox environment (default: the first of project.yaml sandboxes).');
const SEED_APPROVAL = 'Seed steps that run shell commands are approved by the user first (an approval form; else refused with the command a human runs).';

export const sandboxUp = defineTool({
  name: 'sandbox_up',
  title: 'Start a sandbox',
  description: `Start a sandbox of a project (a disposable, local copy of the product, sandbox.yaml), as a job: what is not running is started, health is checked, and it is seeded when it never was or its seed changed. ${SEED_APPROVAL} Nothing outside the sandbox is touched.`,
  input: z.strictObject({ project: projectSlug, env: sandboxEnv, wait_s: waitS(20, 'the sandbox to be up') }),
  annotations: SANDBOX_JOB,
  async run({ project, env, wait_s }, ctx) {
    const sub = await ctx.engine.sandbox.up({ project, env }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    return jobOutput(ctx.engine, sub.job, wait_s, ctx, `sandbox up of ${project} (${sub.env}) submitted (job ${sub.job.id}).`);
  },
});

export const sandboxReset = defineTool({
  name: 'sandbox_reset',
  title: 'Reset a sandbox',
  description: `Put a running sandbox back to its seed, as a job (strategy reseed: the seed again; snapshot: the seeded database restored), its mailbox emptied. Only the data the sandbox owns is rewritten. reseed: true runs the seed even when a snapshot could be restored. ${SEED_APPROVAL} run_capture {sandbox: true} resets it before a take by itself.`,
  input: z.strictObject({
    project: projectSlug,
    env: sandboxEnv,
    reseed: z.boolean().default(false).describe('Run the seed even when a snapshot could be restored.'),
    wait_s: waitS(20, 'the reset to finish'),
  }),
  annotations: SANDBOX_JOB,
  async run({ project, env, reseed, wait_s }, ctx) {
    const sub = await ctx.engine.sandbox.reset({ project, env, reseed }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    return jobOutput(ctx.engine, sub.job, wait_s, ctx, `sandbox reset of ${project} (${sub.env}) submitted (job ${sub.job.id}).`);
  },
});

export const ENVIRONMENT_TOOLS = [authStatus, authLogin, sandboxStatus, sandboxUp, sandboxReset] as const satisfies readonly ToolDef[];
