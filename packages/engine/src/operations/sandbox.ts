/**
 * The sandbox operations: sandbox_status, and sandbox_up / sandbox_reset, jobs the worker runs, with the approvals of
 * their shell seed steps and shell reset hooks taken at submit through the shell's approver (MCP's elicitation) when it
 * has one. Their summaries are auth.ts's job output. sandbox_init (R-SBX-08) writes Retake's own
 * docker-compose scaffold — the tool's content, never over a file — as component_create writes its own; what the
 * sandbox then runs (compose.yaml, sandbox.yaml) is the user's to fill in.
 */
import { z } from 'zod';
import { READ, SANDBOX_JOB, WRITE_FILES } from './annotations.js';
import { jobOutput } from './auth.js';
import { defineOperation } from './define.js';
import { envName, projectSlug } from './schema.js';
import { waitS } from './wait.js';
import { snapshotStatusText } from '../format.js';

export const sandboxStatus = defineOperation({
  name: 'sandbox_status',
  title: 'Status of a sandbox',
  description: 'A sandbox environment of a project (sandbox.yaml): up / partial / down, its services (running, healthy), pages, last seed and reset, and the take lock. It starts nothing.',
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
        ...(s.snapshot ? [`snapshot ${snapshotStatusText(project, s.env, s.snapshot)}`] : []),
        s.lock ? `in use by: ${s.lock.command}` : 'take lock: free',
        ...(s.state !== 'up' ? [`start it: sandbox_up {project: "${project}", env: "${s.env}"}`] : []),
      ].join('\n'),
      data: s,
    };
  },
});

const sandboxEnv = envName.optional().describe('The sandbox environment (default: the first of project.yaml sandboxes).');
const SEED_APPROVAL = 'Seed steps that run shell commands are approved by the user first (an approval form; else refused with the command a human runs).';

export const sandboxUp = defineOperation({
  name: 'sandbox_up',
  title: 'Start a sandbox',
  description: `Start a sandbox of a project (a disposable, local copy of the product, sandbox.yaml), as a job: what is not running is started, health is checked, and it is seeded when it never was or its seed changed. ${SEED_APPROVAL} A docker-compose sandbox pulls the images its compose file names that are not on this machine yet (a download nothing asks about): ask the user before the first up. It builds the images of the compose file that are missing: a build secret (a private registry token) comes from sandbox.yaml compose.secrets (a {{keychain:…}} reference) — this job never has the user's shell tokens, so an empty one is refused before the build, saying what to write. Nothing outside the sandbox is touched.`,
  input: z.strictObject({ project: projectSlug, env: sandboxEnv, wait_s: waitS(20, 'the sandbox to be up') }),
  annotations: SANDBOX_JOB,
  async run({ project, env, wait_s }, ctx) {
    const sub = await ctx.engine.sandbox.up({ project, env }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    return jobOutput(ctx.engine, sub.job, wait_s, ctx, `sandbox up of ${project} (${sub.env}) submitted (job ${sub.job.id}).`);
  },
});

export const sandboxReset = defineOperation({
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

export const sandboxInit = defineOperation({
  name: 'sandbox_init',
  title: 'Scaffold a sandbox',
  description:
    "Write Retake's docker-compose sandbox scaffold into a project (the tool's own files: sandbox.yaml, compose.yaml with a placeholder app, Postgres and Mailpit on free local ports, a demo seed, README.md) and add its `sandboxes.<env>` line to project.yaml — nothing else of project.yaml changes, no existing file is ever overwritten, nothing is started or pulled. Offer it with the user's go-ahead when project_get says a sandbox is missing. The user then fills compose.yaml and sandbox.yaml (the product's images or source, its seed, its accounts) — propose the text in chat; do not write those files yourself. sandbox_up then pulls the images the compose file names (a download): ask the user first.",
  input: z.strictObject({
    project: projectSlug,
    env: envName.optional().describe('The sandbox environment to create (default "sandbox"): lower-case letters, digits, "-" and "_"; not a name of project.yaml environments.'),
  }),
  annotations: WRITE_FILES,
  async run({ project, env }, { engine }) {
    const r = await engine.sandbox.init(project, env);
    const envArg = r.is_default ? '' : `, env: "${r.env}"`;
    return {
      summary: [
        `sandbox ${r.env} of ${project} scaffolded in ${r.dir} (docker-compose): ${r.files.map((f) => f.slice(r.dir.length + 1)).join(', ')}`,
        `project.yaml: ${r.project_yaml.action === 'added' ? `added ${r.project_yaml.entry}` : `${r.project_yaml.entry} was already there`} (nothing else changed)`,
        `ports (127.0.0.1): app ${r.ports.app} · Postgres ${r.ports.db} · Mailpit ${r.ports.mailpit}`,
        ...r.warnings.map((w) => `warning: ${w}`),
        `next: compose.yaml's app is a placeholder — the user puts the product in it and fills sandbox.yaml (${r.dir}/README.md says how; propose the text in chat, the files are theirs). sandbox_up {project: "${project}"${envArg}} then pulls the compose file's images (postgres, mailpit, busybox: a download) — ask the user first.`,
      ].join('\n'),
      data: r,
    };
  },
});
