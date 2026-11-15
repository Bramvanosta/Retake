/**
 * R-SBX-10: what a snapshot reset does with what it finds (reset-plan.ts) — a seed never runs
 * on a take's data. Pure: every branch here, the order of the calls in reset-order.test.ts, the SQL against a real
 * Postgres in snapshot-base.test.ts (`pnpm test:pg`), the whole sandbox in compose.test.ts (RETAKE_TEST_DOCKER=1).
 */
import { describe, expect, it } from 'vitest';
import { freshDatabase, outdatedText, outdatedWhy, resetPlan, restartAfterRestore } from '../src/reset-plan.js';
import type { ResetPlanInput } from '../src/reset-plan.js';

/** A sandbox whose snapshot holds seed `h1` (state, record and template agree), no base. */
const current = (over: Partial<ResetPlanInput> = {}): ResetPlanInput => ({
  reseed: false,
  hash: 'h1',
  stateSeedHash: 'h1',
  recorded: { hash: 'h1', database: 'app' },
  database: 'app',
  template: { present: true, valid: true },
  faValid: true,
  base: false,
  everReset: true,
  unseeded: false,
  empty: false,
  ...over,
});

/** A database Retake never touched. */
const fresh = (over: Partial<ResetPlanInput> = {}): ResetPlanInput => ({
  reseed: false,
  hash: 'h1',
  database: 'app',
  template: { present: false, valid: false },
  faValid: true,
  base: false,
  everReset: false,
  unseeded: false,
  empty: false,
  ...over,
});

describe('the snapshot reset ladder', () => {
  it('an outdated snapshot with a base restores the base and seeds it again (seed, images, firebase_auth, template gone, reseed)', () => {
    const cases: Array<[Partial<ResetPlanInput>, string]> = [
      [{ hash: 'h2' }, 'seed'], // seed steps, their files, images, env file: the hash moved
      [{ template: { present: true, valid: false } }, 'seed'], // the template's comment names another seed
      [{ faValid: false }, 'firebase_auth'], // reset.firebase_auth added: no saved accounts yet (the field case)
      [{ template: { present: false, valid: false } }, 'template'], // dropped by hand
      [{ reseed: true }, 'reseed'],
      [{ database: 'other', recorded: { hash: 'h1', database: 'app' } }, 'database'],
    ];
    for (const [over, why] of cases) {
      expect(resetPlan(current({ ...over, base: true })), JSON.stringify(over)).toEqual({ kind: 'from-base', why });
    }
  });

  it('no base but the outdated snapshot: that snapshot restored, then the seed — never a refusal in the common case', () => {
    expect(resetPlan(current({ hash: 'h2' }))).toEqual({ kind: 'from-snapshot', why: 'seed' });
    expect(resetPlan(current({ faValid: false }))).toEqual({ kind: 'from-snapshot', why: 'firebase_auth' });
    expect(resetPlan(current({ reseed: true }))).toEqual({ kind: 'from-snapshot', why: 'reseed' });
    // A lost state file: the template survives in the cluster, so the database is no fresh one.
    expect(resetPlan(fresh({ template: { present: true, valid: true } }))).toEqual({ kind: 'from-snapshot', why: 'seed' });
  });

  it('an outdated snapshot without a base nor a template refuses, unless the database is fresh', () => {
    // The template is gone (dropped by hand, or a bind mount kept the data while down --volumes forgot the state).
    expect(resetPlan(current({ template: { present: false, valid: false } }))).toEqual({ kind: 'refuse', why: 'template' });
    // A reseed sandbox switched to strategy snapshot: seeded and reset before, no template ever — no base from its data.
    const switched = fresh({ stateSeedHash: 'h0', everReset: true });
    expect(freshDatabase(switched)).toBe(false);
    expect(resetPlan(switched)).toEqual({ kind: 'refuse', why: 'template' });
    // Reset once but never seeded under this state (an interrupted seed after down without --volumes): not fresh either.
    expect(resetPlan(fresh({ everReset: true }))).toMatchObject({ kind: 'refuse' });
    expect(resetPlan(fresh({ stateSeedHash: 'h0' }))).toMatchObject({ kind: 'refuse' });
    expect(resetPlan(fresh({ recorded: { hash: 'h0', database: 'app' } }))).toMatchObject({ kind: 'refuse' });
    // Started without its seed (`up --no-seed`), then used: what it holds is no clean start.
    expect(freshDatabase(fresh({ unseeded: true }))).toBe(false);
    expect(resetPlan(fresh({ unseeded: true }))).toMatchObject({ kind: 'refuse' });
  });

  it('an empty database is a first seed whatever the state says; a template or a base still wins over emptiness', () => {
    // A volume removed outside Retake, a down --volumes done before bases existed, a switched strategy: the state
    // remembers a seed, the database holds nothing.
    for (const over of [{ stateSeedHash: 'h0', everReset: true }, { recorded: { hash: 'h0', database: 'app' } }, { unseeded: true }]) {
      expect(freshDatabase(fresh({ ...over, empty: true })), JSON.stringify(over)).toBe(true);
      expect(resetPlan(fresh({ ...over, empty: true })), JSON.stringify(over)).toEqual({ kind: 'first-seed' });
    }
    expect(resetPlan(current({ empty: true, hash: 'h2' }))).toEqual({ kind: 'from-snapshot', why: 'seed' });
    expect(resetPlan(fresh({ empty: true, base: true }))).toEqual({ kind: 'from-base', why: 'template' });
  });

  it('reset.snapshot.database renamed: a new, empty database gets its first seed; one with its own old template seeds from it (why database)', () => {
    const renamed = current({ database: 'shop', template: { present: false, valid: false } });
    expect(resetPlan({ ...renamed, empty: true })).toEqual({ kind: 'first-seed' });
    expect(resetPlan(renamed)).toEqual({ kind: 'refuse', why: 'template' });
    // Back to a database whose template is still there: restored from it, then seeded (the record names another one).
    expect(resetPlan(current({ database: 'shop', template: { present: true, valid: true } }))).toEqual({ kind: 'from-snapshot', why: 'database' });
    expect(outdatedText('database')).toBe('reset.snapshot.database names another database');
  });

  it('a first seed on a database Retake never snapshotted takes the base before the seed; a database with a snapshot template and no base never gets one', () => {
    expect(freshDatabase(fresh())).toBe(true);
    expect(resetPlan(fresh())).toEqual({ kind: 'first-seed' });
    expect(resetPlan(fresh({ faValid: false }))).toEqual({ kind: 'first-seed' });
    expect(resetPlan(fresh({ reseed: true }))).toEqual({ kind: 'first-seed' });
    // A template in the cluster (snapshotted before bases existed): seeded from it, never a base taken from seeded data.
    expect(resetPlan(current({ hash: 'h2' })).kind).not.toBe('first-seed');
    // An interrupted first seed: its base was taken before the seed — the next reset starts from it.
    expect(resetPlan(fresh({ base: true }))).toEqual({ kind: 'from-base', why: 'template' });
  });

  it('a current snapshot is restored; reseed with a base goes through the base', () => {
    expect(outdatedWhy(current())).toBeNull();
    expect(resetPlan(current())).toEqual({ kind: 'restore' });
    expect(resetPlan(current({ base: true }))).toEqual({ kind: 'restore' });
    expect(resetPlan(current({ base: true, reseed: true }))).toEqual({ kind: 'from-base', why: 'reseed' });
  });

  it('says why in words', () => {
    expect(outdatedText('seed')).toMatch(/^the seed changed — its steps, the files they read, the databases, the services' images or the env file$/);
    expect(outdatedText('firebase_auth')).toMatch(/Firebase Auth emulator's saved accounts/);
    expect(outdatedText('template')).toBe('its snapshot is gone');
  });

  it('after a restore, restarts the running services but the database and what it depends on, in their order', () => {
    expect(
      restartAfterRestore({
        running: ['proxy', 'db', 'app', 'worker', 'mailpit', 'pgbouncer'],
        depends: { app: ['db', 'pgbouncer'], worker: ['app'], db: ['proxy'], pgbouncer: ['db'] },
        database: 'db',
      }),
    ).toEqual(['app', 'worker', 'mailpit', 'pgbouncer']);
    // Not running (a profile, stopped by hand): never started by a reset.
    expect(restartAfterRestore({ running: ['db', 'mailpit'], depends: {}, database: 'db' })).toEqual(['mailpit']);
    // A dependency cycle ends.
    expect(restartAfterRestore({ running: ['db', 'a', 'b'], depends: { db: ['a'], a: ['db'] }, database: 'db' })).toEqual(['b']);
  });
});
