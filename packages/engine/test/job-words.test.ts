/**
 * A job in words, written once (job-words.ts): what each kind does, a running job's progress and a finished job's
 * outcome, as the MCP server's and the Studio's summary line (jobLine, brief) and the terminal's `retake jobs` (full)
 * show them. The table pins every kind's words.
 */
import { describe, expect, it } from 'vitest';
import { jobOutcome, jobProgress, jobWhat } from '../src/operations/job-words.js';
import { jobLine } from '../src/contract.js';
import type { JobInput, JobProgress, JobRecord, JobResult } from '../src/index.js';

const input = (i: Record<string, unknown>) => ({ submitted_by: 'mcp', project: 'p', ...i }) as unknown as JobInput;
const result = (r: Record<string, unknown>) => r as unknown as JobResult;
const progress = (p: Record<string, unknown>) => ({ steps_done: 0, steps_total: 0, updated_at: 'x', ...p }) as JobProgress;

describe('jobWhat: each kind says what it does', () => {
  const table: Array<[Record<string, unknown>, string]> = [
    [{ kind: 'run', scenario: 'quote', mode: 'dry', run_id: 'r1' }, 'run quote (dry) → r1'],
    [{ kind: 'run', scenario: 'quote', mode: 'capture', run_id: 'r1', env: 'staging' }, 'run quote (capture) on staging → r1'],
    [{ kind: 'hooks', source: 'catalogue:setup', dry: true, env: 'local' }, 'hooks catalogue:setup (dry) on local'],
    [{ kind: 'env_reset', dry: true, env: 'local' }, 'env reset (dry) on local'],
    [{ kind: 'env_reset' }, 'env reset'],
    [{ kind: 'auth_login', persona: 'buyer', mode: 'headed', env: 'local' }, 'sign-in of buyer (headed) on local'],
    [{ kind: 'auth_login', mode: 'auto' }, 'sign-in of the persona (auto)'],
    [{ kind: 'sandbox_up', env: 'local' }, 'sandbox up on local'],
    [{ kind: 'sandbox_reset', reseed: true }, 'sandbox reset (reseed)'],
    [{ kind: 'render', scenario: 'quote', run_id: 'r1', render_id: 'quote-v1', template: 'editorial' }, 'render quote (run r1, theme editorial) → quote-v1'],
    [{ kind: 'render', scenario: 'quote', run_id: 'r1', render_id: 'quote-v1' }, 'render quote (run r1) → quote-v1'],
    [{ kind: 'review', render_id: 'quote-v1', fps: 2 }, 'review quote-v1 (2 fps)'],
    [{ kind: 'review', render_id: 'quote-v1' }, 'review quote-v1'],
    [{ kind: 'export', render_id: 'quote-v1', formats: ['mp4', 'gif'] }, 'export quote-v1 → mp4, gif'],
    [{ kind: 'preview', target: { kind: 'component', component: 'intro' }, template: 'motion', preview_id: 'pv1' }, 'preview of intro (theme motion) → pv1'],
    [{ kind: 'preview', target: { kind: 'library', items: [1] }, preview_id: 'pv1' }, 'preview of 1 library component → pv1'],
    [{ kind: 'preview', target: { kind: 'library', items: [1, 2] }, preview_id: 'pv1' }, 'preview of 2 library components → pv1'],
    [{ kind: 'preview', target: { kind: 'theme' }, preview_id: 'pv1' }, 'preview of the theme → pv1'],
    [{ kind: 'inspect', source: { kind: 'page', page: 'console', path: '/orders' }, env: 'local', inspect_id: 'i1' }, 'inspect page console /orders on local → i1'],
    [{ kind: 'inspect', source: { kind: 'scenario', scenario: 'quote', until: 'pay.2' }, inspect_id: 'i1' }, 'inspect scenario quote until pay.2 → i1'],
    [{ kind: 'record', scenario: 'quote', source: { page: 'console', path: '/' }, env: 'local', rec_id: 'rec1' }, 'record quote from page console / on local → rec1'],
    [{ kind: 'record', source: { page: 'console', path: '/' }, rec_id: 'rec1' }, 'record a scenario from page console / → rec1'],
    [{ kind: 'site', url: 'https://example.com/', site_id: 's1' }, 'site extraction of https://example.com/ → s1'],
  ];
  it.each(table)('%j', (i, words) => expect(jobWhat(input(i))).toBe(words));
});

describe('jobProgress: a percent when the job knows it, else steps or a phase', () => {
  const table: Array<[Record<string, unknown>, string]> = [
    [{ steps_done: 3, steps_total: 12 }, '3/12 steps'],
    [{ steps_done: 3, steps_total: 12, phase: 'scenes' }, '3/12 steps · scenes'],
    [{ steps_done: 3, steps_total: 12, phase: 'scenes', current: { scene: 'pay', step: 2, action: 'click' } }, '3/12 steps · pay.2 click'],
    [{ phase: 'preflight' }, 'preflight'],
    // A review (and a render while it bundles) has no step count: its percent is shown, not only its phase.
    [{ phase: 'bundling', fraction: 0.05 }, '5 % · bundling'],
    [{ steps_done: 40, steps_total: 300, phase: 'rendering', fraction: 0.333, eta_s: 12 }, '33 % · rendering · ~12 s left'],
    [{ fraction: 0.5 }, '50 %'],
  ];
  it.each(table)('%j', (p, words) => expect(jobProgress(progress(p))).toBe(words));
});

describe('jobOutcome: brief for the summary line, full (with where) for the terminal', () => {
  const table: Array<[Record<string, unknown>, string, string]> = [
    [{ kind: 'run', status: 'succeeded', steps_done: 3, steps_total: 12 }, 'run succeeded', 'run succeeded · 3/12 steps'],
    [{ kind: 'hooks', ok: true }, 'ok', 'ok'],
    [{ kind: 'env_reset', ok: false }, 'with failures', 'with failures'],
    [{ kind: 'auth_login', signed_in: true, status: 'valid' }, 'signed in', 'signed in (valid)'],
    [{ kind: 'auth_login', signed_in: false, status: 'expired' }, 'not signed in (expired)', 'not signed in (expired)'],
    [{ kind: 'render', duration_s: 12.5, width: 1920, height: 1080, file: '/w/q.mp4' }, '12.5 s 1920×1080', '12.5 s 1920×1080 → /w/q.mp4'],
    [{ kind: 'review', clean: true, counts: { error: 0, warning: 0 }, dir: '/w/r' }, 'clean', 'clean → /w/r'],
    [{ kind: 'review', clean: false, counts: { error: 2, warning: 1 }, dir: '/w/r' }, '2 errors, 1 warnings', '2 errors, 1 warnings → /w/r'],
    [{ kind: 'export', outputs: [1], failed: ['gif'], dir: '/w/e' }, '1 files, 1 failed', '1 files, 1 failed → /w/e'],
    [{ kind: 'preview', images: [1], theme: 'default', dir: '/w/p' }, '1 image (default theme)', '1 image (default theme) → /w/p'],
    [{ kind: 'preview', images: [1, 2], theme: 'default', dir: '/w/p' }, '2 images (default theme)', '2 images (default theme) → /w/p'],
    [{ kind: 'inspect', reported: true, status: 'ok', counts: { listed: 7 }, dir: '/w/i' }, 'ok, 7 elements listed', 'ok, 7 elements listed → /w/i'],
    [{ kind: 'inspect', reported: false, run_status: 'failed', dir: '/w/i' }, 'not inspected (replay failed)', 'not inspected (replay failed) → /w/i'],
    [{ kind: 'record', not_saved: 'nothing_recorded', stats: { steps: 0 }, saved: null, check: { status: 'skipped' } }, 'nothing recorded', 'nothing recorded'],
    [{ kind: 'record', stats: { steps: 4 }, saved: { file: '/w/s.yaml' }, check: { status: 'passed' } }, '4 steps, saved, check passed', '4 steps → /w/s.yaml · check passed'],
    [{ kind: 'record', stats: { steps: 4 }, saved: null, not_saved: 'name_taken', check: { status: 'failed' } }, '4 steps, check failed', '4 steps (not saved: name_taken) · check failed'],
    [{ kind: 'site', status: 'ok', candidates: [1], palette: { roles: { accent: '#ff0000' } }, dir: '/w/s' }, '1 logo candidate', '1 logo candidate, accent #ff0000 → /w/s'],
    [{ kind: 'site', status: 'ok', candidates: [1, 2], palette: { roles: { accent: null } }, dir: '/w/s' }, '2 logo candidates', '2 logo candidates, accent none → /w/s'],
    [{ kind: 'site', status: 'failed', candidates: [], palette: null, dir: '/w/s' }, 'the page could not be read', 'the page could not be read → /w/s'],
    [{ kind: 'sandbox_up', reset: null }, 'up, no seed needed', 'up, no seed needed'],
    [{ kind: 'sandbox_reset', reset: { strategy: 'snapshot' } }, 'reset snapshot', 'reset snapshot'],
  ];
  it.each(table)('%j', (r, brief, full) => {
    expect(jobOutcome(result(r), 'brief')).toBe(brief);
    expect(jobOutcome(result(r), 'full')).toBe(full);
  });
});

describe('jobLine composes the same words', () => {
  const job = (j: Partial<JobRecord>): JobRecord =>
    ({ version: 1, id: 'j_x', kind: 'render', created_at: 'x', input: input({ kind: 'render', scenario: 'quote', run_id: 'r1', render_id: 'quote-v1' }), state: 'queued', ...j }) as JobRecord;

  it('a running job: its progress; a cancel asked is said', () => {
    const j = job({ state: 'running', progress: progress({ phase: 'bundling', fraction: 0.05 }), cancel_requested_at: 'x' });
    expect(jobLine(j)).toBe('j_x render quote (run r1) → quote-v1 in p: running · 5 % · bundling (cancel requested)');
  });

  it('a finished job: its brief outcome; a held job: why it waits', () => {
    expect(jobLine(job({ state: 'succeeded', result: result({ kind: 'render', duration_s: 3, width: 640, height: 360, file: '/f' }) }))).toBe(
      'j_x render quote (run r1) → quote-v1 in p: succeeded · 3 s 640×360',
    );
    expect(jobLine(job({ yield: { state: 'waiting', cause: 'here' } }))).toBe('j_x render quote (run r1) → quote-v1 in p: queued · waiting for a take to finish (in this workspace)');
  });
});
