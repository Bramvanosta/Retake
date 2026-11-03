import { z } from 'zod';
import { HOOKS_SOURCE_RE } from '@retake/core';
import type { Engine, HookResultView, JobRecord } from '@retake/engine';
import { envName, projectSlug } from '../schema.js';
import { plural } from '../result.js';
import type { ToolOutput } from '../result.js';
import { HOOK_JOB, defineTool } from './define.js';
import type { ToolContext, ToolDef } from './define.js';
import { waitJob, waitS } from './run.js';

/** One hook's line, from the trusted fields only (what a hook returned stays under "untrusted"). */
function hookLine(r: HookResultView): string {
  const icon = r.status === 'ok' ? '✓' : r.status === 'dry' ? '◦' : '✗';
  const who = r.phase === 'rollback' ? `rollback of journal entry ${r.journal_seq ?? r.index}` : `${r.index + 1}. ${r.name ?? r.declared ?? `${r.kind ?? 'invalid'} hook`}${r.name && r.declared ? ` (${r.declared})` : ''}`;
  const status = r.status === 'dry' ? 'checked, not executed' : r.status === 'ok' ? 'ran' : r.status === 'refused' ? 'refused (the reason is under "untrusted")' : 'failed (the error is under "untrusted")';
  return `  ${icon} ${who}: ${status}${r.approval ? ` — ${r.status === 'dry' ? 'needs a human approval to run' : 'approval'}: ${r.approval.reason}` : ''}${r.optional ? ' (optional)' : ''}`;
}

/** The summary of a hooks or env_reset job: its state, then one line per hook. */
export function hooksJobSummary(job: JobRecord): string {
  const head = `job ${job.id}: ${job.state}`;
  const r = job.result;
  if (!r || (r.kind !== 'hooks' && r.kind !== 'env_reset')) {
    return [head, ...(job.error ? [`${job.error.message}${job.error.fix ? ` — fix: ${job.error.fix}` : ''}`] : []), ...(job.state === 'queued' || job.state === 'running' ? [`follow it: job_status {job_id: "${job.id}", wait_s: 25}`] : [])].join('\n');
  }
  const lines = [head];
  if (r.kind === 'hooks') {
    lines.push(`${r.phase} hooks ${r.source} on ${r.env}${r.dry ? ' (dry: nothing executed)' : ''}: ${r.ok ? 'ok' : 'with failures'}${r.interrupted ? ' — cancelled' : ''}`);
    lines.push(...r.results.map(hookLine));
    if (r.journal?.pending) lines.push(`${plural(r.journal.pending, 'rollback')} pending in journal ${r.journal.id}: env_reset replays them`);
  } else {
    lines.push(`environment reset of ${r.env}${r.dry ? ' (dry: nothing executed)' : ''}: ${r.ok ? 'ok' : 'with failures'}${r.interrupted ? ' — cancelled' : ''}`);
    if (!r.rollbacks.length) lines.push('no pending rollbacks');
    for (const j of r.rollbacks) {
      lines.push(`rollbacks of ${j.journal}${j.untrusted ? ': the journal could not be read (under "untrusted")' : ''}`);
      lines.push(...j.results.map(hookLine));
    }
    if (r.reset === null) lines.push('no reset hooks in project.yaml');
    else lines.push('reset hooks:', ...r.reset.map(hookLine));
  }
  if (r.dry && [...(r.kind === 'hooks' ? r.results : (r.reset ?? []))].some((x) => x.approval)) {
    lines.push('A real run (dry: false) asks the user to approve the hooks marked above.');
  }
  if (job.error && job.state !== 'succeeded') lines.push(`${job.error.message}${job.error.fix ? ` — fix: ${job.error.fix}` : ''}`);
  return lines.join('\n');
}

async function jobOutput(engine: Engine, job: JobRecord, seconds: number, ctx: ToolContext, intro: string): Promise<ToolOutput> {
  await waitJob(engine, job, seconds, ctx);
  const now = await engine.jobs.get(job.id);
  return { summary: `${intro}\n${hooksJobSummary(now)}`, data: now as unknown as Record<string, unknown> };
}

const dryInput = z
  .boolean()
  .default(true)
  .describe('Default true: template and security-check the hooks without executing anything (nobody is asked). false runs them: hooks that are destructive or run shell commands need the user\'s approval first.');

export const hooksRun = defineTool({
  name: 'hooks_run',
  title: 'Run hooks',
  description:
    'Run setup / teardown / reset hooks outside a capture, as a job: source is "reset" (project.yaml), "<scenario>:setup", "<scenario>:teardown" or "hooks/<name>.yaml". dry (default true) only describes and checks them: the result lists each hook and which ones would need the user\'s approval. With dry: false they run; destructive hooks and shell hooks are approved by the user first (an approval form: "confirm: true" in a file does not count here) — a decline, or a client that cannot ask, refuses with the command a human runs. Setup-like hooks journal their rollbacks: env_reset replays them. Production / read-only environments refuse hooks that write (a shell hook always counts as writing here).',
  input: z.strictObject({
    project: projectSlug,
    source: z
      .string()
      .max(120)
      .regex(HOOKS_SOURCE_RE, 'reset, <scenario>:setup, <scenario>:teardown or hooks/<name>.yaml (never another path)')
      .describe('reset | <scenario>:setup | <scenario>:teardown | hooks/<name>.yaml'),
    env: envName.optional().describe("Environment (default: the scenario's env, else the project's default_env)."),
    dry: dryInput,
    wait_s: waitS(20, 'the hooks to finish'),
  }),
  annotations: HOOK_JOB,
  async run({ project, source, env, dry, wait_s }, ctx) {
    const sub = await ctx.engine.hooks.submit({ project, source, env, dry }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    return jobOutput(ctx.engine, sub.job, wait_s, ctx, `hooks ${source}${dry ? ' (dry)' : ''} submitted (job ${sub.job.id}).`);
  },
});

export const envReset = defineTool({
  name: 'env_reset',
  title: 'Reset an environment',
  description:
    'Put an environment back as the hooks found it, as a job: replay every pending rollback (journals of captures and hook runs, most recent first — also those an interrupted job left), then run the project\'s reset hooks. dry (default true) only describes them. With dry: false, reset hooks that are destructive or run shell commands are approved by the user first (else refused with the command a human runs); rollbacks are never asked about (they undo).',
  input: z.strictObject({
    project: projectSlug,
    env: envName.optional().describe("Environment (default: the project's default_env)."),
    dry: dryInput,
    wait_s: waitS(20, 'the reset to finish'),
  }),
  annotations: HOOK_JOB,
  async run({ project, env, dry, wait_s }, ctx) {
    const sub = await ctx.engine.env.reset({ project, env, dry }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    return jobOutput(ctx.engine, sub.job, wait_s, ctx, `environment reset${dry ? ' (dry)' : ''} submitted (job ${sub.job.id}).`);
  },
});

export const HOOK_TOOLS: ToolDef[] = [hooksRun, envReset];
