/**
 * R-SBX-10, R-SBX-11: what a sandbox job's summary and `sandbox_status` say about an outdated
 * snapshot (seeded again from the base, else from the outdated snapshot, with how to get a base; a refusal is the
 * job's failure with the sandbox's words) and about the Firebase Auth accounts a reset put back (the personas that sign
 * in again at the next take, those without login steps).
 */
import { describe, expect, it } from 'vitest';
import { environmentJobSummary } from '../src/operations/auth.js';
import { firebaseAuthText, resetLadderText, snapshotStatusText } from '../src/format.js';
import { sandboxTakeNotes } from '../src/execute-run.js';
import type { JobRecord, SandboxJobResult } from '../src/jobs/types.js';
import { sandboxStatus } from '../src/sandbox.js';
import type { Sandboxes } from '../src/sandboxes/sandboxes.js';
import { PERSON_POLICY } from '@retake/core';
import type { LoadedProject } from '@retake/core';

const reset = (over: Partial<NonNullable<SandboxJobResult['reset']>>): NonNullable<SandboxJobResult['reset']> => ({
  strategy: 'snapshot',
  restored: false,
  ms: 900,
  seed: { steps: 1, ms: 40 },
  mailbox: 'cleared',
  snapshot: { action: 'taken', ms: 30, database: 'app' },
  restarted: [],
  superseded: 0,
  ...over,
});

const job = (r: SandboxJobResult['reset'], state: JobRecord['state'] = 'succeeded', error?: JobRecord['error']): JobRecord =>
  ({
    id: 'j1',
    state,
    result: { kind: 'sandbox_reset', env: 'sandbox', provider: 'docker-compose', reset: r, pages: { app: 'http://localhost:4600' } },
    ...(error ? { error } : {}),
  }) as unknown as JobRecord;

describe('sandbox words', () => {
  it('an outdated snapshot seeded again from the base, or from itself with how to get a base; a first seed keeps a base', () => {
    const fromBase = environmentJobSummary(
      job(reset({ base: { action: 'restored', ms: 12 }, outdated: { why: 'seed', reason: 'the seed changed', from: 'base', restarted: ['app'] }, restarted: ['app'] })),
    );
    expect(fromBase).toContain('reset (snapshot): snapshot outdated (the seed changed): base restored in 12 ms · seed 1 step · mailbox emptied · restarted app');
    const hint =
      'no base to start from (the database before its first seed): … retake sandbox down shop --env sandbox --volumes (it deletes every volume of the sandbox …), then retake sandbox up shop --env sandbox';
    const fromSnapshot = environmentJobSummary(job(reset({ outdated: { why: 'firebase_auth', reason: 'accounts missing', from: 'snapshot', restarted: [], hint } })));
    expect(fromSnapshot).toContain('snapshot outdated (accounts missing): outdated snapshot restored (no base) · seed 1 step');
    expect(fromSnapshot).toContain(`${hint} (sandbox down is the user's to run, in their terminal)`);
    expect(environmentJobSummary(job(reset({ base: { action: 'taken', ms: 9 } })))).toContain('reset (snapshot): base kept in 9 ms (the database before its first seed) · seed 1 step');
  });

  it("a refused reset is the failed job with the sandbox's words", () => {
    const refused = environmentJobSummary(
      job(null, 'failed', {
        kind: 'failed',
        message: 'sandbox sandbox: its snapshot is outdated (its snapshot is gone) … Nothing was changed. Start from a fresh database: retake sandbox down shop --env sandbox --volumes …',
      } as never),
    );
    expect(refused).toMatch(/^job j1: failed\n/);
    expect(refused).toContain('Nothing was changed. Start from a fresh database: retake sandbox down shop --env sandbox --volumes');
  });

  it('sandbox_status says what the next reset does with the snapshot', () => {
    // One wording: `retake sandbox status`'s snapshot line and sandbox_status's summary.
    const t = (o: Parameters<typeof snapshotStatusText>[2]) => snapshotStatusText('shop', 'sandbox', o);
    expect(t({ base: true, next: 'restore' })).toBe('current · base kept');
    expect(t({ base: false, next: 'first-seed' })).toBe('none yet — the first seed keeps a base (the database before it), then takes the snapshot');
    expect(t({ reason: 'the seed changed', base: true, next: 'from-base' })).toBe(
      'outdated (the seed changed) — the next reset restores the base, restarts the services, seeds and takes a new snapshot',
    );
    expect(t({ reason: 'x', base: false, next: 'from-snapshot' })).toBe(
      'outdated (x), no base — the next reset restores the outdated snapshot and seeds on it (seeds reset what they create); retake sandbox down shop --env sandbox --volumes --forget (every volume of the sandbox, and the records forgotten), then retake sandbox up shop --env sandbox gives it a base',
    );
    expect(t({ base: false, next: 'refuse' })).toBe(
      'no base nor snapshot, and the database already holds data — the next reset refuses: start from a fresh database in a terminal, retake sandbox down shop --env sandbox --volumes --forget (every volume of the sandbox, and the records forgotten), then retake sandbox up shop --env sandbox',
    );
    // FB-31: the command follows where the data lives — never one that leaves the refusal as it is.
    const vol = { kind: 'volume', where: 'shop_pgdata' };
    expect(t({ base: false, next: 'refuse', storage: vol })).toBe(
      'no base nor snapshot, and the database already holds data — the next reset refuses: start from a fresh database in a terminal, retake sandbox down shop --env sandbox --volumes (every volume of the sandbox), then retake sandbox up shop --env sandbox',
    );
    expect(t({ base: false, next: 'refuse', storage: { kind: 'tmpfs', where: '/var/lib/postgresql/data' } })).toBe(
      'no base nor snapshot, and the database already holds data — the next reset refuses: start from a fresh database in a terminal, retake sandbox down shop --env sandbox, then retake sandbox up shop --env sandbox · data in memory (tmpfs): every down takes it',
    );
    expect(t({ base: false, next: 'refuse', storage: { kind: 'bind', where: '/srv/pg' } })).toBe(
      'no base nor snapshot, and the database already holds data — the next reset refuses: start from a fresh database in a terminal, retake sandbox down shop --env sandbox --volumes, then retake sandbox up shop --env sandbox, once the folder /srv/pg is emptied (a bind mount: --volumes leaves it)',
    );
    expect(t({ base: true, next: 'restore', storage: { kind: 'container', where: '/var/lib/postgresql/data' } })).toBe("current · base kept · data in the container's own layer: every down takes it");
    expect(t({ base: true, next: 'restore', storage: { kind: 'volume' } })).toBe('current · base kept · data in an anonymous volume: every down leaves it behind (the next up starts a new one)');
    expect(t({ base: false, next: 'first-seed', new_cluster: true, storage: vol })).toBe(
      'none — its Postgres is a new cluster (the data went with the old one): the next reset forgets the old seed and snapshot, keeps a base and seeds it',
    );
    expect(t({ base: false, detail: 'sandbox down' })).toBe('unknown (sandbox down)');
  });

  it("the ladder's words, the same for the CLI, the job and the run note; the run's notes carry the hint as a warning", () => {
    expect(resetLadderText({})).toBeUndefined();
    expect(resetLadderText({ base: { action: 'taken', ms: 9 } })).toBe('base kept in 9 ms (the database before its first seed)');
    expect(resetLadderText({ outdated: { reason: 'r', from: 'snapshot' } })).toBe('snapshot outdated (r): outdated snapshot restored (no base)');
    const up = { started: [], kept: ['app'], changed: [], ms: 0 };
    const base = {
      strategy: 'snapshot' as const,
      restored: false,
      ms: 2900,
      hash: 'h',
      at: '',
      seed: { steps: 1, ms: 30 },
      mailbox: 'none' as const,
      restarted: [],
      superseded: 0,
      hooks: { steps: 0, ms: 0 },
    };
    expect(sandboxTakeNotes('sandbox', 'docker-compose', { up, reset: { ...base, snapshot: { action: 'restored', ms: 210, database: 'app' }, restored: true } })).toEqual([
      ['info', 'sandbox sandbox (docker-compose) · running · healthy 1/1 · reset snapshot 2.9 s (snapshot restored in 210 ms)'],
    ]);
    expect(
      sandboxTakeNotes('sandbox', 'docker-compose', {
        up,
        reset: {
          ...base,
          snapshot: { action: 'taken', ms: 20, database: 'app' },
          outdated: { why: 'seed', reason: 'the seed changed', from: 'snapshot', restarted: ['app'], hint: 'no base to start from …' },
        },
      }),
    ).toEqual([
      ['info', 'sandbox sandbox (docker-compose) · running · healthy 1/1 · reset snapshot 2.9 s (snapshot outdated (the seed changed): outdated snapshot restored (no base) · seeded, snapshot taken)'],
      ['warn', 'sandbox sandbox: no base to start from …'],
    ]);
  });

  it('the reset words name the sandbox personas whose saved sessions it signed out, and those without login steps', () => {
    expect(firebaseAuthText({ accounts: 3, personas: { login: ['admin', 'owner'], no_login: [] } })).toBe(
      '3 Firebase Auth accounts put back — admin, owner sign in again at the next take, off camera',
    );
    expect(firebaseAuthText({ accounts: 1, personas: { login: ['admin'], no_login: ['viewer'] } })).toBe(
      '1 Firebase Auth account put back — admin signs in again at the next take, off camera (viewer: no login steps — give accounts.viewer login steps in sandbox.yaml, or the next take refuses it)',
    );
    expect(firebaseAuthText({ accounts: 2 })).toBe('2 Firebase Auth accounts put back');
    expect(environmentJobSummary(job(reset({ firebase_auth: { accounts: 2, personas: { login: ['owner'], no_login: [] } } })))).toContain(
      ' · 2 Firebase Auth accounts put back — owner signs in again at the next take, off camera',
    );
  });

  it("sandbox_status keeps the snapshot's error under untrusted, never in its own fields", async () => {
    const status = {
      env: 'sandbox',
      provider: 'docker-compose',
      file: '/p/sandbox/sandbox.yaml',
      state: 'up',
      services: [],
      logs: '/p/.retake/sandbox/sandbox/logs',
      notes: [],
      snapshot: { state: 'unknown', base: false, detail: 'its database could not be read', error: 'container other-shop-db-1 …' },
    };
    const handle = { env: 'sandbox', status: async () => status };
    const sandboxes = { open: async () => handle } as unknown as Sandboxes;
    const project = {
      slug: 'shop',
      dir: '/p',
      config: { environments: { sandbox: { app: 'http://localhost:4600' } }, sandboxes: { sandbox: 'sandbox/sandbox.yaml' } },
      sandboxes: { sandbox: { env: 'sandbox', manifest: { services: {} } } },
    } as unknown as LoadedProject;
    const view = await sandboxStatus(project, 'sandbox', PERSON_POLICY, { refOf: (f: string) => f } as never, sandboxes);
    expect(view.snapshot).toEqual({ state: 'unknown', base: false, detail: 'its database could not be read' });
    expect(view.untrusted).toEqual({ health: {}, snapshot_error: 'container other-shop-db-1 …' });
  });
});
