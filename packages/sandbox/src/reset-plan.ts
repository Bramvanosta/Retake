/**
 * R-SBX-10: what a snapshot reset does, decided from what it finds — pure, so every branch is
 * a unit test. A seed never runs on a take's data:
 *
 *   restore        the snapshot holds this seed (hash in the state and in its comment, the Firebase accounts saved
 *                  for it, the same database): restored.
 *   from-base      outdated (seed, images, env file, firebase_auth, template gone, database changed, reseed asked)
 *                  and the base is there: the base restored, the running services restarted, the seed, a new snapshot.
 *   from-snapshot  outdated, no base but the outdated template: that template restored, the services restarted, the
 *                  seed (seeds reset what they create: the documented contract), a new snapshot — and the person is
 *                  told once how to get a base.
 *   first-seed     neither base nor template, and the database is fresh: it holds no relation of its own (asked of
 *                  Postgres: whatever the state says — a volume removed outside Retake, a renamed
 *                  `reset.snapshot.database`), or the state says nothing ever used it (never seeded, reset, snapshotted
 *                  nor started without its seed since the data last went: an app that migrates at boot leaves tables
 *                  before its first seed). The base taken, the seed, the snapshot.
 *   refuse         neither base nor template, and the database already holds data nobody can vouch for: refused
 *                  before anything changes.
 */

/** Why a snapshot cannot be restored as it is. */
export type OutdatedWhy = 'seed' | 'firebase_auth' | 'template' | 'database' | 'reseed';

export interface ResetPlanInput {
  /** `reset --reseed` (or `sandbox_reset {reseed: true}`). */
  reseed: boolean;
  /** The seed hash now (core seedHash with the provider's inputs). */
  hash: string;
  /** The state's last seed. */
  stateSeedHash?: string;
  /** The state's snapshot record (provider_state.snapshot). */
  recorded?: { hash: string; database: string };
  /** The database the reset works on now. */
  database: string;
  /** The template under its present name (after an earlier name was adopted). */
  template: { present: boolean; valid: boolean };
  /** The Firebase Auth emulator's saved accounts are this seed's (true without `reset.firebase_auth`). */
  faValid: boolean;
  /** The base of this database is in the cluster. */
  base: boolean;
  /** The state records a reset (cleared when `down --volumes` really removes the data). */
  everReset: boolean;
  /** The state records an `up` without its seed since the data last went (the product may have been used). */
  unseeded: boolean;
  /** The database holds no relation of its own (Postgres says; read only when there is neither base nor template). */
  empty: boolean;
}

export type ResetPlan =
  | { kind: 'restore' }
  | { kind: 'first-seed' }
  | { kind: 'from-base'; why: OutdatedWhy }
  | { kind: 'from-snapshot'; why: OutdatedWhy }
  | { kind: 'refuse'; why: OutdatedWhy };

/** The first reason the snapshot cannot be restored as it is (null: it can). */
export function outdatedWhy(i: ResetPlanInput): OutdatedWhy | null {
  if (i.reseed) return 'reseed';
  if (!i.template.present) return 'template';
  if (i.recorded && i.recorded.database !== i.database) return 'database';
  if (i.stateSeedHash !== i.hash || i.recorded?.hash !== i.hash || !i.template.valid) return 'seed';
  if (!i.faValid) return 'firebase_auth';
  return null;
}

/** Nothing ever used this database: it is empty, or the state says Retake never seeded, reset, snapshotted nor started it unseeded. */
export function freshDatabase(i: ResetPlanInput): boolean {
  if (i.template.present || i.base) return false;
  return i.empty || (!i.recorded && i.stateSeedHash === undefined && !i.everReset && !i.unseeded);
}

export function resetPlan(i: ResetPlanInput): ResetPlan {
  const why = outdatedWhy(i);
  if (why === null) return { kind: 'restore' };
  if (i.base) return { kind: 'from-base', why };
  if (i.template.present) return { kind: 'from-snapshot', why };
  if (freshDatabase(i)) return { kind: 'first-seed' };
  return { kind: 'refuse', why };
}

/** "the seed changed (…)": why, in words. */
export function outdatedText(why: OutdatedWhy): string {
  switch (why) {
    case 'seed':
      return "the seed changed — its steps, the files they read, the databases, the services' images or the env file";
    case 'firebase_auth':
      return "the Firebase Auth emulator's saved accounts are missing or of another seed";
    case 'template':
      return 'its snapshot is gone';
    case 'database':
      return 'reset.snapshot.database names another database';
    case 'reseed':
      return 'the seed was asked for again (reseed)';
  }
}

/**
 * The services restarted after the base or an outdated snapshot is restored (before the seed): the ones running now,
 * in their order, but the database's own service and every service it depends on (restarting them would stop the
 * database the reset just restored). Boot-time migrations of a rebuilt image then run on the restored data.
 */
export function restartAfterRestore(o: { running: readonly string[]; depends: Readonly<Record<string, readonly string[]>>; database: string }): string[] {
  const keep = new Set<string>();
  const visit = (s: string) => {
    if (keep.has(s)) return;
    keep.add(s);
    for (const d of o.depends[s] ?? []) visit(d);
  };
  visit(o.database);
  return o.running.filter((s) => !keep.has(s));
}
