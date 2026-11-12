/**
 * The sign-in operations the shells share (moved from the MCP server's tools/environment.ts in L7.13): auth_status,
 * auth_login, and the summary of an auth_login or sandbox job (also the MCP server's sandbox_up / sandbox_reset's).
 */
import { z } from 'zod';
import { SLUG_RE } from '@retake/core';
import type { Engine } from '../engine.js';
import { signInStoppedText } from '../jobs/auth-job.js';
import type { JobRecord } from '../jobs/types.js';
import { READ, SIGN_IN } from './annotations.js';
import { defineOperation } from './define.js';
import type { ToolContext } from './define.js';
import { envName, projectSlug } from './schema.js';
import { waitJob, waitS } from './wait.js';
import { plural } from './words.js';

export const authStatus = defineOperation({
  name: 'auth_status',
  title: 'Sessions of personas',
  description:
    'Every persona (signed-in account) of the workspace, or of one project: valid, expired, error, never signed in or saved but unchecked, when it was last checked and by what, and the command a human runs to sign it in. It reads the last known state and opens no browser. Claude never types credentials: auth_login opens a window for the user to sign in, or a human runs the command.',
  input: z.strictObject({
    project: projectSlug.optional().describe('Only this project.'),
    env: envName.optional().describe('With project: only this environment.'),
  }),
  annotations: READ,
  async run({ project, env }, { engine }) {
    const r = await engine.auth.status({ project, env });
    const lines = r.personas.map((p) => {
      const next = p.sandbox ? '' : p.status === 'never' || p.status === 'expired' || p.status === 'error' ? ` — sign it in: auth_login (the user signs in in a window), or a human runs ${p.command ?? p.fix}` : '';
      return `- ${p.project} · ${p.env} · ${p.persona}: ${p.sandbox && p.status === 'never' ? 'sandbox account (a take signs it in automatically)' : p.status}${p.in_use ? ' (in use by a browser)' : ''}${next}`;
    });
    return {
      summary: [
        r.personas.length ? `${plural(r.personas.length, 'persona')}:\n${lines.join('\n')}` : `No personas${project ? ` in ${project}` : ''}.`,
        ...r.errors.map((e) => `${e.project}: does not load`),
      ].join('\n'),
      data: r,
    };
  },
});

/** The summary of an auth_login or sandbox job: its state, then what it did (or why it did not). */
export function environmentJobSummary(job: JobRecord): string {
  const lines = [`job ${job.id}: ${job.state}`];
  const r = job.result;
  if (r?.kind === 'auth_login') {
    lines.push(
      r.interrupted
        ? `sign-in of ${r.persona} on ${r.env} ${r.timed_out ? 'stopped' : 'cancelled'}: ${signInStoppedText(r)}`
        : r.signed_in
          ? `${r.persona} on ${r.env}: ${r.status === 'unchecked' ? 'session saved, not verified (the persona has no check)' : `signed in${r.already_signed_in ? ' (its session was still valid)' : ''}${r.kept ? ' — the window ended signed out; the session saved before still works and is kept' : ''}`}. Runs use a copy of this session.`
          : `${r.persona} on ${r.env} is not signed in (${r.status}; the check's message is under "untrusted"). A human tries again: ${r.command}`,
    );
  } else if (r?.kind === 'sandbox_up' || r?.kind === 'sandbox_reset') {
    if (r.services) lines.push(`services: ${[r.services.started.length ? `started ${r.services.started.join(', ')}` : '', r.services.kept.length ? `already running ${r.services.kept.join(', ')}` : ''].filter(Boolean).join(' · ') || 'none'}${r.services.changed.length ? ` (changed in sandbox.yaml since they started: ${r.services.changed.join(', ')} — down, then up)` : ''}`);
    if (r.reset) {
      const seed = r.reset.restored ? `snapshot${r.reset.snapshot ? ` of ${r.reset.snapshot.database}` : ''} restored` : `seed ${plural(r.reset.seed.steps, 'step')}`;
      lines.push(`reset (${r.reset.strategy}): ${seed}${r.reset.mailbox === 'cleared' ? ' · mailbox emptied' : ''}${r.reset.restarted.length ? ` · restarted ${r.reset.restarted.join(', ')}` : ''}${r.reset.firebase_auth ? ` · ${plural(r.reset.firebase_auth.accounts, 'Firebase Auth account')} put back` : ''}${r.reset.hooks?.steps ? ` · ${plural(r.reset.hooks.steps, 'reset hook')}` : ''}${r.reset.superseded ? ` · ${plural(r.reset.superseded, 'pending rollback')} superseded` : ''}`);
    } else lines.push('no seed needed (already seeded with the current seed)');
    lines.push(`pages: ${Object.entries(r.pages).map(([k, u]) => `${k} ${u}`).join(' · ')}`);
  }
  if (job.error && job.state !== 'succeeded') lines.push(`${job.error.message}${job.error.fix ? ` — a human runs: ${job.error.fix}` : ''}`);
  if (job.state === 'queued' || job.state === 'running') lines.push(`follow it: job_status {job_id: "${job.id}", wait_s: 25}`);
  return lines.join('\n');
}

/** A job submitted by a call, waited on (when asked) and answered with its summary after `intro`. */
export async function jobOutput(engine: Engine, job: JobRecord, seconds: number, ctx: ToolContext, intro: string) {
  await waitJob(engine, job, seconds, ctx);
  const now = await engine.jobs.get(job.id);
  return { summary: `${intro}\n${environmentJobSummary(now)}`, data: now };
}

export const authLogin = defineOperation({
  name: 'auth_login',
  title: 'Sign a persona in',
  description:
    'Sign a persona (an account of project.yaml auth.personas) in, as a job. mode "headed" (default) opens a browser window on the user\'s machine: the USER signs in there and closes the window — you never see, ask for or type a password; tell the user what to do, then follow the job with job_status {wait_s: 25} (it ends when the window is closed). mode "auto" plays the persona\'s login steps of project.yaml (their secrets come from the user\'s environment or keychain), headless. The result says whether the session works now. One job runs at a time: a sign-in window holds the queue until it is closed.',
  input: z.strictObject({
    project: projectSlug,
    persona: z.string().max(100).regex(SLUG_RE, 'a persona name of project.yaml').optional().describe("The persona (default: the environment's only one)."),
    env: envName.optional().describe("Environment (default: the project's default_env)."),
    mode: z.enum(['headed', 'auto']).default('headed').describe('headed (default): a window for the user to sign in; auto: the persona\'s login steps, headless.'),
    wait_s: waitS(0, 'the sign-in to finish'),
  }),
  annotations: SIGN_IN,
  async run({ project, persona, env, mode, wait_s }, ctx) {
    const sub = await ctx.engine.auth.login({ project, persona, env, mode });
    const intro =
      mode === 'headed'
        ? `A browser window is opening on the user's machine for ${sub.persona} (${project}, env ${sub.env}). Ask the user to sign in there, then close the window. Never ask for their password. (job ${sub.job.id})`
        : `Signing ${sub.persona} in with its login steps, headless (${project}, env ${sub.env}; job ${sub.job.id}).`;
    return jobOutput(ctx.engine, sub.job, wait_s, ctx, intro);
  },
});
