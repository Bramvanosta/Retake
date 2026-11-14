/**
 * L7.29 (audit 2026-11-10 P7): each job kind's handler (jobs/job-handlers.ts), on stand-in execute functions — the
 * state, error and progress rule each kind ends with, as runJob's switch over the kinds had them (run-job-record.ts at
 * 394c30e): a cancelled run (its untrusted message), hooks / env_reset / sign-in interrupted, an export cancelled between
 * formats; the kinds whose record keeps their last progress; what a handler hands its execute function.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleJob } from '../src/jobs/job-handlers.js';
import type { JobRun } from '../src/jobs/job-handlers.js';

// The stand-ins (vi.mock is hoisted above the imports).

const { calls, answers, answer } = vi.hoisted(() => {
  const calls: Array<{ kind: string; ctx: Record<string, unknown> }> = [];
  const answers: Record<string, unknown> = {};
  const answer = (kind: string) => async (ctx: Record<string, unknown>) => {
    calls.push({ kind, ctx });
    return answers[kind];
  };
  return { calls, answers, answer };
});

vi.mock('../src/jobs/run-job.js', () => ({ executeRunJob: answer('run'), pauseMaxMs: () => undefined }));
vi.mock('../src/jobs/hooks-job.js', () => ({ executeHooksJob: answer('hooks'), executeEnvResetJob: answer('env_reset') }));
vi.mock('../src/jobs/auth-job.js', () => ({ executeAuthLoginJob: answer('auth_login'), signInStoppedText: (r: { timed_out?: boolean }) => (r.timed_out ? 'timed out' : 'closed') }));
vi.mock('../src/jobs/sandbox-job.js', () => ({ executeSandboxJob: answer('sandbox') }));
vi.mock('../src/jobs/live-channel.js', () => ({ openLiveChannel: async () => ({ sink: 'live', close: async () => undefined }) }));
vi.mock('../src/jobs/render-job.js', () => ({ executeRenderJob: answer('render') }));
vi.mock('../src/jobs/review-job.js', () => ({ executeReviewJob: answer('review') }));
vi.mock('../src/jobs/export-job.js', () => ({ executeExportJob: answer('export') }));
vi.mock('../src/jobs/preview-job.js', () => ({ executePreviewJob: answer('preview') }));
vi.mock('../src/jobs/inspect-job.js', () => ({ executeInspectJob: answer('inspect') }));
vi.mock('../src/jobs/record-job.js', () => ({ executeRecordJob: answer('record') }));
vi.mock('../src/jobs/site-job.js', () => ({ executeSiteJob: answer('site') }));

function jobRun(over: Partial<JobRun> = {}, aborted = false): JobRun {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    id: 'j_1',
    base: { signal: controller.signal, queue: { stopOf: async () => undefined, jobFile: async () => 'f' } } as never,
    interrupts: () => 'interrupts' as never,
    progress: () => undefined,
    browser: () => undefined,
    renderer: 'renderer' as never,
    files: {} as never,
    self: { pid: 1 } as never,
    log: () => undefined,
    pause: { requested: false },
    filming: () => ({ on: () => undefined, close: () => undefined }),
    stopAsked: new AbortController(),
    slot: {},
    ...over,
  };
}

const handle = (input: Record<string, unknown>, run = jobRun()) => handleJob(input as never, run);

describe('one handler per job kind (L7.29): the state each kind ends with, as the switch had it', () => {
  it('a run: succeeded, or cancelled with its untrusted message (else "run cancelled"); its progress kept; the live picture and the pause gate handed on', async () => {
    answers.run = { status: 'succeeded' };
    expect(await handle({ kind: 'run', run_id: 'r', mode: 'dry' })).toEqual({ result: { status: 'succeeded' }, state: 'succeeded', progress: true });
    expect(calls.at(-1)!.ctx).toMatchObject({ live: 'live', interrupts: 'interrupts', pause: { requested: false } });
    expect(calls.at(-1)!.ctx).not.toHaveProperty('onFilming');
    answers.run = { status: 'cancelled', untrusted: { error_message: 'stopped at step 3' } };
    expect(await handle({ kind: 'run', run_id: 'r', mode: 'capture' })).toMatchObject({ state: 'cancelled', error: { code: 'cancelled', message: 'stopped at step 3' }, progress: true });
    expect(calls.at(-1)!.ctx).toHaveProperty('onFilming');
    answers.run = { status: 'cancelled' };
    expect((await handle({ kind: 'run', run_id: 'r', mode: 'dry' })).error).toEqual({ code: 'cancelled', message: 'run cancelled' });
  });

  it('hooks, env_reset, sign-in: cancelled when interrupted, with their words; no progress kept', async () => {
    answers.hooks = { interrupted: true };
    expect(await handle({ kind: 'hooks' })).toEqual({ result: { interrupted: true }, state: 'cancelled', error: { code: 'cancelled', message: 'hooks cancelled: the remaining hooks did not run' } });
    answers.env_reset = { interrupted: true };
    expect((await handle({ kind: 'env_reset' })).error?.message).toBe('environment reset cancelled: the remaining hooks did not run');
    answers.env_reset = { interrupted: false };
    expect(await handle({ kind: 'env_reset' })).toEqual({ result: { interrupted: false }, state: 'succeeded' });
    answers.auth_login = { interrupted: true, timed_out: true };
    expect((await handle({ kind: 'auth_login' })).error).toEqual({ code: 'cancelled', message: 'sign-in stopped: timed out' });
    answers.auth_login = { interrupted: true };
    expect((await handle({ kind: 'auth_login' })).error).toEqual({ code: 'cancelled', message: 'sign-in cancelled: closed' });
    answers.sandbox = { up: true };
    expect(await handle({ kind: 'sandbox_reset' })).toEqual({ result: { up: true }, state: 'succeeded' });
    expect(calls.at(-1)!.ctx).toMatchObject({ interrupts: 'interrupts' });
  });

  it('an export cancelled between formats: cancelled, what was written in its result and its words; else succeeded', async () => {
    answers.export = { outputs: [{ format: 'a' }] };
    expect(await handle({ kind: 'export', formats: ['a', 'b'] })).toEqual({ result: answers.export, state: 'succeeded', progress: true });
    expect(await handle({ kind: 'export', formats: ['a', 'b'] }, jobRun({}, true))).toEqual({
      result: answers.export,
      state: 'cancelled',
      error: { code: 'cancelled', message: 'export cancelled: 1 of 2 formats written' },
      progress: true,
    });
  });

  it('render, review, preview, inspect, record, site: succeeded with their progress kept; the renderer, the free space and the record window handed on only when given', async () => {
    for (const kind of ['render', 'review', 'preview', 'inspect', 'record', 'site']) {
      answers[kind] = { kind };
      expect(await handle({ kind })).toEqual({ result: { kind }, state: 'succeeded', progress: true });
    }
    expect(calls.find((c) => c.kind === 'render')!.ctx).toMatchObject({ renderer: 'renderer' });
    expect(calls.find((c) => c.kind === 'preview')!.ctx).not.toHaveProperty('freeBytes');
    expect(calls.find((c) => c.kind === 'record')!.ctx).not.toHaveProperty('window');
    const freeBytes = async () => 1;
    const recordWindow = { headless: true };
    const slot: JobRun['slot'] = {};
    await handle({ kind: 'preview' }, jobRun({ freeBytes }));
    expect(calls.at(-1)!.ctx).toMatchObject({ freeBytes });
    await handle({ kind: 'record' }, jobRun({ recordWindow, slot }));
    expect(calls.at(-1)!.ctx).toMatchObject({ window: recordWindow, jobId: 'j_1' });
    // The record job's worker stop is held in the slot while it runs, and released after.
    expect(slot.currentStop).toBeUndefined();
  });
});
