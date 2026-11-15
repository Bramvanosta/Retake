/**
 * R-SBX-10, R-SBX-11: what `retake sandbox up` / `reset` print about a reset — the ladder's words (shared with the job
 * summary and the run note: engine format.ts), the Firebase Auth accounts put back, and the hint (how to get a base) as
 * a warning of its own.
 */
import { describe, expect, it } from 'vitest';
import type { ResetResult } from '@retake/sandbox/types';
import { resetText, resetWarnings } from '../src/commands/sandbox.js';

const reset = (over: Partial<ResetResult>): ResetResult => ({
  strategy: 'snapshot',
  restored: false,
  ms: 2900,
  hash: 'h',
  at: '2026-11-15T21:31:07.000Z',
  seed: { steps: 1, ms: 30 },
  mailbox: 'cleared',
  snapshot: { action: 'taken', ms: 20, database: 'app' },
  restarted: [],
  superseded: 0,
  hooks: { steps: 0, ms: 0 },
  ...over,
});

describe("the CLI's reset words", () => {
  it('an outdated snapshot seeded from the base, from itself, a first seed keeping a base, a restore', () => {
    expect(resetText(reset({ base: { action: 'restored', ms: 410 }, outdated: { why: 'seed', reason: 'the seed changed', from: 'base', restarted: ['app'] }, restarted: ['app', 'app'] }))).toBe(
      'snapshot 2.9 s · snapshot outdated (the seed changed): base restored in 410 ms · seed 1 step (30 ms) · snapshot of app taken in 20 ms · mailbox emptied · restarted app, app',
    );
    expect(resetText(reset({ outdated: { why: 'firebase_auth', reason: 'accounts missing', from: 'snapshot', restarted: [], hint: 'no base to start from …' } }))).toBe(
      'snapshot 2.9 s · snapshot outdated (accounts missing): outdated snapshot restored (no base) · seed 1 step (30 ms) · snapshot of app taken in 20 ms · mailbox emptied',
    );
    expect(resetText(reset({ base: { action: 'taken', ms: 9 } }))).toBe('snapshot 2.9 s · base kept in 9 ms (the database before its first seed) · seed 1 step (30 ms) · snapshot of app taken in 20 ms · mailbox emptied');
    expect(resetText(reset({ restored: true, snapshot: { action: 'restored', ms: 212, database: 'app' }, seed: { steps: 0, ms: 0 } }))).toBe('snapshot 2.9 s · snapshot of app restored in 212 ms · mailbox emptied');
    expect(resetText(reset({ firebase_auth: { accounts: 2, at: '', personas: { login: ['owner'], no_login: [] } } }))).toContain(' · 2 Firebase Auth accounts put back — owner signs in again at the next take, off camera');
  });

  it('the hint is a warning of its own, never in the line; none without it', () => {
    const r = reset({ outdated: { why: 'seed', reason: 'r', from: 'snapshot', restarted: [], hint: 'no base to start from …' } });
    expect(resetWarnings(r)).toEqual(['no base to start from …']);
    expect(resetText(r)).not.toContain('no base to start from');
    expect(resetWarnings(reset({}))).toEqual([]);
    expect(resetWarnings(undefined)).toEqual([]);
  });
});
