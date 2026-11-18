/**
 * A sandbox of a project: `openSandbox(project, env?)` → `up`, `down`, `reset`, `status`, `logs`,
 * `prepareTake` — the API the CLI's `retake sandbox …` / `retake run --sandbox` and the MCP tools call.
 *
 * - up: start what is not running (health checked, ports owned), then seed when it was never seeded, when the seed
 *   changed (core seedHash) or when it started a service (a restarted process lost its in-memory data); `seed: 'never'`
 *   skips that.
 * - reset: back to the seed — strategy reseed: the seed again; strategy snapshot (docker-compose + Postgres): the
 *   template copy of the seeded database restored, or, when it is outdated (reset-plan.ts), the base — the database
 *   before its first seed — restored (else the outdated snapshot), the running services restarted, the seed again and
 *   a new snapshot taken; refused before anything changes when there is neither and the database is not fresh —, the
 *   pending rollbacks of the environment superseded as soon as the data is back, then the
 *   mailbox emptied and `reset.restart` services restarted. The mailbox and the seed's databases must be the
 *   sandbox's own (checked before anything changes).
 * - prepareTake: the take lock, up (without seeding), health, reset; the caller films, then releases the lock. The
 *   sandbox stays up afterwards.
 * - up / reset / down / prepareTake hold the take lock (a busy sandbox fails fast); status and logs never lock.
 * An interrupted or failed up / prepareTake stops the services that call started, and only those.
 */
import { copyFileSync, existsSync, statSync, truncateSync } from 'node:fs';
import { isIP } from 'node:net';
import { sandboxNames } from '@retake/core/sandbox';
import { seedHash } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedSandbox, RunSandbox, SandboxResetStrategy } from '@retake/core/sandbox';
import type { SandboxHookRunner } from '@retake/core/hooks';
import type { WorkPolicy } from '@retake/core/policy';
import { SandboxError, interrupted } from './errors.js';
import { TakeLock, lockAlive, readLock } from './lock.js';
import type { LockRecord } from './lock.js';
import { sandboxPaths, shownPath } from './paths.js';
import type { SandboxPaths } from './paths.js';
import { ComposeProvider } from './compose.js';
import { ProcessProvider, tailLines } from './process.js';
import type {
  DownResult,
  Provider,
  SecretRefResolver,
  ProviderCapabilities,
  ProviderContext,
  SandboxLog,
  SandboxProgress,
  SeedRecorder,
  SeedTrust,
  ServiceLogFile,
  ServiceStatus,
  UpResult,
} from './provider.js';
import { checkMailbox, checkSeedDatabases, clearMailbox, runSeed, supersede } from './seed.js';
import { killGroupSync } from './proc.js';
import { PostgresSnapshot, describeDatabase, snapshotTarget } from './snapshot-postgres.js';
import type { BaseState, SnapshotPort, SnapshotState, SnapshotTarget } from './snapshot-postgres.js';
import { outdatedText, resetPlan, restartAfterRestore } from './reset-plan.js';
import type { OutdatedWhy, ResetPlan, ResetPlanInput } from './reset-plan.js';
import type { DataStorage } from './provider.js';
import { readState, writeState } from './state.js';
import { FirebaseAuthSnapshot } from './firebase-auth.js';
import type { SandboxState } from './state.js';
import { bestEffort, errorMessage } from '@retake/core/base';

/** Logs above this size are cut (kept as `<log>.1`) before a take: a sandbox may stay up for days. */
export const LOG_CAP_BYTES = 20 * 1024 * 1024;

export interface SandboxCallOptions {
  signal?: AbortSignal;
  log?: SandboxLog;
  /** The steps of the call as they start, and what each is doing (SandboxProgress). */
  progress?: SandboxProgress;
  /** Trust `mcp` for the seed steps this call may run (a shell step then needs an approval). */
  seedTrust?: SeedTrust;
  /** Each seed step run (hooks HookContext.recordRun): the engine journals it as its caller's. */
  recordSeedRun?: SeedRecorder;
}

export interface ResetResult {
  strategy: SandboxResetStrategy;
  /** A snapshot was restored (docker-compose + Postgres), rather than the seed run again. */
  restored: boolean;
  ms: number;
  /** The seed's hash (core seedHash). */
  hash: string;
  at: string;
  seed: { steps: number; ms: number };
  mailbox: 'cleared' | 'kept' | 'none' | 'not-mailpit';
  /** Strategy snapshot: the template restored, or (re)taken after the seed, and how long that took. */
  snapshot?: { action: 'restored' | 'taken'; ms: number; database: string };
  restarted: string[];
  /** Pending rollbacks of the environment that will not be replayed any more. */
  superseded: number;
  /**
   * Hotfix v0.2.5: the Firebase Auth emulator's accounts put back (`reset.firebase_auth`); `at`: when — a
   * persona session saved before it is signed out (state `accounts_at`).
   */
  firebase_auth?: {
    accounts: number;
    at: string;
    /** The sandbox's accounts (its personas) a take signs in again with their login steps, and those that have none (a take refuses them). */
    personas: { login: string[]; no_login: string[] };
  };
  /** The base (the database before its first seed) taken before the first seed, or restored before a seed again. */
  base?: { action: 'taken' | 'restored'; ms: number };
  /**
   * The snapshot was outdated — why, what the seed started from (the base, else the outdated snapshot), the
   * services restarted before the seed, and (no base) how to get one.
   */
  outdated?: { why: OutdatedWhy; reason: string; from: 'base' | 'snapshot'; restarted: string[]; hint?: string };
  /** Hotfix v0.2.5: `reset.hooks` run once the data was back. */
  hooks: { steps: number; ms: number };
}

export interface SandboxUpResult extends UpResult {
  /** The seed run by this up (never seeded, seed changed, or a service started), if any. */
  reset?: ResetResult;
}

export interface SandboxStatus {
  env: string;
  provider: LoadedSandbox['manifest']['provider'];
  /** sandbox.yaml. */
  file: string;
  /** up: every service running and healthy; down: none running; partial: anything between. */
  state: 'up' | 'partial' | 'down';
  services: ServiceStatus[];
  /** The last seed: its hash (12 characters), and whether sandbox.yaml's seed is still the same. */
  seed?: { hash: string; at: string; ms: number; current: boolean };
  last_reset?: SandboxState['last_reset'];
  /** The take lock, when a live command holds it. */
  lock?: LockRecord;
  /**
   * Strategy snapshot: the snapshot now and what the next reset does with it (`next`: reset-plan.ts) — unknown
   * when the sandbox is down or its Postgres does not answer (`detail`). Read only: nothing renamed, repaired or locked.
   */
  snapshot?: {
    state: 'current' | 'outdated' | 'none' | 'unknown';
    why?: OutdatedWhy;
    reason?: string;
    base: boolean;
    next?: ResetPlan['kind'];
    /** Why unknown, in fixed words (`sandbox down`, `its database could not be read`). */
    detail?: string;
    /** The error that made it unknown, as it was thrown: text of other programs, never instructions. */
    error?: string;
  };
  /** When the Firebase Auth emulator's accounts were last put back (personas saved before sign in again). */
  accounts_at?: string;
  /** Folder of the service logs. */
  logs: string;
  notes: string[];
}

/** The logs of one service: its file (process) or where the provider read them (`source`, docker-compose). */
export interface SandboxLogs extends ServiceLogFile {
  source?: string;
  exists: boolean;
  text: string;
}

/**
 * A take's hold on its sandbox. The engine's in-memory Sandboxes port (engine sandboxes/memory-sandboxes.ts) answers the
 * same take on purpose, without a process; the port's contract suite (engine test/sandbox-contract.ts) runs both.
 */
export interface Take {
  /** What run.json / timeline.json record (`environment.sandbox`). */
  info: RunSandbox;
  up: UpResult;
  reset: ResetResult;
  /** Name the run filmed under the lock. */
  note(run: string): void;
  /** Release the take lock (the sandbox stays up). */
  release(): Promise<void>;
}

const quiet: SandboxLog = () => undefined;

/** The provider of a sandbox.yaml (a fresh instance: it remembers what one call started). */
export function providerFor(sandbox: LoadedSandbox, policy: WorkPolicy): Provider {
  return sandbox.manifest.provider === 'process' ? new ProcessProvider() : new ComposeProvider({ policy });
}

/** What a Sandbox is built with besides its project (tests: a fake provider and a fake Postgres, to see the order of a reset). */
export interface SandboxDeps {
  /** The provider of each call (default providerFor). */
  provider?: (sandbox: LoadedSandbox, policy: WorkPolicy) => Provider;
  /** What a snapshot reset works through (default PostgresSnapshot.open). */
  openSnapshot?: (target: SnapshotTarget, env: string, opts: { timeoutMs?: number }) => Promise<SnapshotPort>;
}

/** How long `status` waits for the sandbox's Postgres (it never blocks a poll for long). */
const STATUS_PG_TIMEOUT_MS = 2_000;

/** The sandbox of environment `env` (default: the first project.yaml declares), for work under `policy` (core WorkPolicy). */
export function openSandbox(project: LoadedProject, env: string | undefined, policy: WorkPolicy, resolveSecret: SecretRefResolver, hooks: SandboxHookRunner): Sandbox {
  const names = sandboxNames(project);
  if (!names.length) throw new SandboxError(`project ${project.slug} has no sandbox: add \`sandboxes: {sandbox: sandbox/sandbox.yaml}\` to project.yaml`);
  const name = env ?? names[0];
  const loaded = project.sandboxes?.[name];
  if (!loaded) throw new SandboxError(`${name} is not a sandbox of project ${project.slug} (sandboxes: ${names.join(', ')})`);
  return new Sandbox(project, loaded, policy, resolveSecret, hooks);
}

export class Sandbox {
  readonly env: string;
  readonly paths: SandboxPaths;
  /** The provider of the current call (a fresh one per call: it remembers what that call started). */
  private provider: Provider;
  private ctx: ProviderContext | null = null;
  /** Process groups of the seed's shell steps running now (a second Ctrl-C kills them). */
  private readonly running = new Set<number>();

  constructor(
    readonly project: LoadedProject,
    readonly sandbox: LoadedSandbox,
    /** What the work runs under (core WorkPolicy). */
    readonly policy: WorkPolicy,
    /** What its secret references are resolved with (its opener's: ProviderContext.resolveSecret). */
    private readonly resolveSecret: SecretRefResolver,
    /** What runs its seed steps and reset hooks (its opener's: ProviderContext.hookRunner). */
    private readonly hookRunner: SandboxHookRunner,
  ) {
    this.env = sandbox.env;
    this.paths = sandboxPaths(project.dir, sandbox.env);
    this.provider = this.newProvider();
  }

  private deps: SandboxDeps = {};

  /** A test's fake provider and Postgres (SandboxDeps), for the calls that follow. */
  withDeps(deps: SandboxDeps): this {
    this.deps = deps;
    this.provider = this.newProvider();
    return this;
  }

  private newProvider(): Provider {
    return (this.deps.provider ?? providerFor)(this.sandbox, this.policy);
  }

  /** process | docker-compose. */
  get kind(): LoadedSandbox['manifest']['provider'] {
    return this.sandbox.manifest.provider;
  }

  get strategy(): SandboxResetStrategy {
    return this.sandbox.manifest.reset?.strategy ?? 'reseed';
  }

  /** What its provider can do beyond what every provider does (ProviderCapabilities: exec, logs, followLogs, snapshots, build, volumes…). */
  get capabilities(): Readonly<ProviderCapabilities> {
    return this.provider.capabilities;
  }

  /** A provider context on the state as it is on disk now. */
  private context(opts: SandboxCallOptions): ProviderContext {
    const log = opts.log ?? quiet;
    const { state, note } = readState(this.paths.state, this.env, this.sandbox.manifest.provider);
    if (note) log('warn', note);
    const ctx: ProviderContext = {
      project: this.project,
      policy: this.policy,
      sandbox: this.sandbox,
      paths: this.paths,
      state,
      save: () => writeState(this.paths.state, ctx.state),
      log,
      resolveSecret: this.resolveSecret,
      hookRunner: this.hookRunner,
      signal: opts.signal,
      ...(opts.progress ? { progress: opts.progress } : {}),
      ...(opts.seedTrust ? { seedTrust: opts.seedTrust } : {}),
      ...(opts.recordSeedRun ? { recordSeedRun: opts.recordSeedRun } : {}),
    };
    this.ctx = ctx;
    return ctx;
  }

  private lock(command: string, log: SandboxLog): TakeLock {
    return TakeLock.acquire(this.paths.lock, command, this.env, (msg) => log('info', msg));
  }

  /**
   * A call that may start services (up, prepareTake), with a fresh provider: when it fails — or is interrupted, even
   * after its last step — the services it started are stopped again, and only those.
   */
  private async starting<T>(ctx: ProviderContext, what: string, fn: () => Promise<T>): Promise<T> {
    this.provider = this.newProvider();
    try {
      const out = await fn();
      if (ctx.signal?.aborted) throw interrupted(`sandbox ${this.env} ${what}`);
      return out;
    } catch (e) {
      const stopped = await bestEffort(this.provider.stopStarted({ ...ctx, signal: undefined }), 'the stop is best effort on a sandbox that failed to start: its own error is the one reported', []);
      if (stopped.length) ctx.log('warn', `stopped what this command had started: ${stopped.join(', ')}`);
      throw e;
    }
  }

  /** The seed hash (core seedHash) with the provider's inputs (docker-compose: the services' image ids). */
  private async hashOf(ctx: ProviderContext): Promise<string> {
    return seedHash(this.sandbox, this.provider.capabilities.hashInputs ? await this.provider.hashInputs(ctx) : []);
  }

  /** Where to connect to a port the sandbox's services publish (capability `address`), else undefined: the URL's own host. */
  private addressOf(ctx: ProviderContext, port: number): Promise<string | undefined> {
    return this.provider.capabilities.address ? this.provider.address(ctx, port) : Promise.resolve(undefined);
  }

  /**
   * The Postgres snapshot of a snapshot reset: its database must be published by the sandbox's own services (`service`:
   * the one publishing it).
   */
  private async openSnapshot(ctx: ProviderContext, opts: { timeoutMs?: number } = {}): Promise<{ snap: SnapshotPort; service: string }> {
    if (!this.provider.capabilities.snapshots) {
      throw new SandboxError(`sandbox ${this.env}: snapshot resets need provider docker-compose (the database must belong to the sandbox): use strategy reseed`);
    }
    const target = await snapshotTarget(this.project, this.sandbox, this.resolveSecret);
    const service = await this.provider.publishedBy(ctx, target.port);
    // A host name: on the address Docker publishes the port on, never `localhost` (another container may publish the
    // same port on ::1); an address is used as written.
    const address = isIP(target.host) ? undefined : await this.addressOf(ctx, target.port);
    const open = this.deps.openSnapshot ?? ((t, env, o) => PostgresSnapshot.open(t, env, o));
    return { snap: await open(address ? { ...target, host: address } : target, this.env, opts), service };
  }

  /** What reset-plan.ts decides from: the state, the cluster's templates and base, the Firebase accounts. */
  private async planInput(ctx: ProviderContext, snap: SnapshotPort, fa: FirebaseAuthSnapshot | null, hash: string, opts: { reseed?: boolean; earlier?: boolean } = {}): Promise<ResetPlanInput> {
    const recorded = ctx.state.provider_state?.snapshot as SnapshotState | undefined;
    const template = await snap.templateState(hash, opts);
    const base = await snap.hasBase();
    return {
      reseed: opts.reseed === true,
      hash,
      ...(ctx.state.seed ? { stateSeedHash: ctx.state.seed.hash } : {}),
      ...(recorded ? { recorded: { hash: recorded.hash, database: recorded.database } } : {}),
      database: snap.target.database,
      template,
      faValid: fa === null || fa.valid(hash),
      base,
      everReset: ctx.state.last_reset !== undefined,
      unseeded: ctx.state.unseeded_at !== undefined,
      // Asked only when it decides: neither base nor template to start from.
      empty: !base && !template.present ? await snap.isEmpty() : false,
    };
  }

  /** `down --volumes` then `up`, and what `--volumes` removes (every volume of the sandbox; not a bind mount nor an external volume). */
  private freshDatabaseText(storage: DataStorage): string {
    const p = this.project.slug;
    const left =
      storage.kind === 'bind'
        ? ` Its database keeps its data in a folder of this machine (${storage.where}, a bind mount): --volumes does not remove it — empty that folder between the two.`
        : storage.kind === 'external'
          ? ` Its database keeps its data in the external volume ${storage.where}: --volumes does not remove it — docker volume rm ${storage.where} between the two.`
          : '';
    return `retake sandbox down ${p} --env ${this.env} --volumes (it deletes every volume of the sandbox: the database, and any uploads, caches or indexes kept in volumes), then retake sandbox up ${p} --env ${this.env} — its first seed then keeps a base, and later changes seed from it by themselves.${left}`;
  }

  /** The refusal of an outdated snapshot with neither base nor template, on a database that is not fresh. */
  private async refusal(ctx: ProviderContext, service: string, why: OutdatedWhy): Promise<SandboxError> {
    const around = await bestEffort(this.provider.servicesAround(ctx, service), 'where the data lives only adds a sentence to the refusal', null);
    const snapshotted = ctx.state.provider_state?.snapshot !== undefined;
    return new SandboxError(
      `sandbox ${this.env}: the database already holds data and there is no base or snapshot to start from${snapshotted ? ` (${outdatedText(why)})` : ''}: seeding on it would freeze that data into the snapshot. Nothing was changed. Start from a fresh database: ${this.freshDatabaseText(around?.storage ?? { kind: 'unknown' })}`,
    );
  }

  /** Where the snapshot's database keeps its data (its service must be running). */
  private async dataStorage(ctx: ProviderContext): Promise<DataStorage> {
    const target = await snapshotTarget(this.project, this.sandbox, this.resolveSecret);
    const service = await this.provider.publishedBy(ctx, target.port);
    return (await this.provider.servicesAround(ctx, service)).storage;
  }

  /** A snapshot kept under its earlier name (a renamed database): renamed or dropped, and the state follows. */
  private async adoptEarlierSnapshot(ctx: ProviderContext, snap: SnapshotPort, recorded: SnapshotState | undefined): Promise<void> {
    const adopted = await snap.adoptEarlier();
    if (adopted) {
      ctx.log(
        'info',
        `sandbox ${this.env}: the snapshot of ${snap.target.database} under its earlier name ${snap.target.earlier}: ${adopted === 'renamed' ? `renamed ${snap.target.template}` : `dropped (${snap.target.template} exists)`}`,
      );
      if (recorded) {
        ctx.state.provider_state = { ...(ctx.state.provider_state ?? {}), snapshot: { ...recorded, template: snap.target.template } };
        ctx.save();
      }
    }
  }

  /**
   * A reset once the data is back: the mailbox emptied, `reset.restart` services restarted — always, after the snapshot
   * was taken (a take ends every session of the database: a service restarted before it would keep a dead pool) —, the
   * emulator's accounts put back, `reset.hooks` run.
   */
  private async afterData(
    ctx: ProviderContext,
    by: string,
    fa: FirebaseAuthSnapshot | null,
  ): Promise<{ mailbox: ResetResult['mailbox']; restarted: string[]; firebaseAuth: ResetResult['firebase_auth']; hooks: ResetResult['hooks'] }> {
    const mailbox = await clearMailbox(this.project, this.sandbox, this.resolveSecret, (port) => this.addressOf(ctx, port));
    if (mailbox === 'not-mailpit') ctx.log('info', `sandbox ${this.env}: an http mailbox has no generic way to be emptied — empty it in a seed step`);
    const restarted: string[] = [];
    for (const name of this.sandbox.manifest.reset?.restart ?? []) {
      ctx.progress?.step(`restart ${name}`);
      await this.provider.restart(ctx, name);
      restarted.push(name);
    }
    // After the restarts (a restarted emulator starts empty): its accounts as the seed left them.
    let firebaseAuth: ResetResult['firebase_auth'];
    if (fa) {
      ctx.progress?.step('firebase auth', 'putting back the accounts saved after the seed');
      const accounts = await fa.restore();
      // The accounts are new to the emulator — a persona session saved before now is signed out.
      const at = new Date().toISOString();
      ctx.state.accounts_at = at;
      ctx.save();
      const all = Object.entries(this.sandbox.manifest.accounts ?? {});
      firebaseAuth = { accounts, at, personas: { login: all.filter(([, a]) => a.login?.length).map(([n]) => n), no_login: all.filter(([, a]) => !a.login?.length).map(([n]) => n) } };
      ctx.log('info', `sandbox ${this.env}: ${accounts} account(s) of the Firebase Auth emulator put back`);
    }
    // reset.hooks: what each take needs undone that the snapshot does not cover.
    const resetHooks = this.sandbox.manifest.reset?.hooks ?? [];
    const hooks = resetHooks.length
      ? await runSeed(ctx, this.provider, { by, log: ctx.log, signal: ctx.signal, running: this.running, steps: resetHooks, what: 'reset hook', indexBase: (this.sandbox.manifest.seed ?? []).length })
      : { steps: 0, ms: 0 };
    return { mailbox, restarted, firebaseAuth, hooks };
  }

  /**
   * An outdated snapshot: the base restored — else the outdated snapshot (seeds reset what they create) —, never what
   * the last take left; then the running services but the database's restarted (a rebuilt image's boot migrations run
   * again on the restored data). The seed follows.
   */
  private async startOver(
    ctx: ProviderContext,
    opened: { snap: SnapshotPort; service: string },
    plan: Extract<ResetPlan, { kind: 'from-base' | 'from-snapshot' }>,
    recorded: SnapshotState | undefined,
  ): Promise<{ base: ResetResult['base']; outdated: NonNullable<ResetResult['outdated']> }> {
    const { snap } = opened;
    const from = plan.kind === 'from-base' ? 'base' : 'snapshot';
    const owner = recorded?.owner ?? (ctx.state.provider_state?.base as BaseState | undefined)?.owner;
    ctx.progress?.step(
      'snapshot',
      `outdated (${outdatedText(plan.why)}): restoring ${from === 'base' ? 'the base (the database before its first seed)' : 'the outdated snapshot'} of ${describeDatabase(snap.target)}`,
    );
    const r = await snap.restore(owner, from);
    ctx.log(
      'info',
      `sandbox ${this.env}: snapshot outdated (${outdatedText(plan.why)}): ${from === 'base' ? 'base' : 'outdated snapshot'} of ${describeDatabase(snap.target)} restored in ${r.ms} ms before the seed`,
    );
    const around = await this.provider.servicesAround(ctx, opened.service);
    const restarted = restartAfterRestore({ running: around.running, depends: around.depends, database: opened.service });
    for (const name of restarted) {
      ctx.progress?.step(`restart ${name}`, 'after the restore, before the seed');
      await this.provider.restart(ctx, name);
    }
    const hint =
      from === 'snapshot'
        ? `no base to start from (the database before its first seed): the seed ran on the outdated snapshot's data, so it must reset what it creates. To give this sandbox a base: ${this.freshDatabaseText(around.storage)}`
        : undefined;
    if (hint) ctx.log('info', `sandbox ${this.env}: ${hint}`);
    return { base: from === 'base' ? { action: 'restored', ms: r.ms } : undefined, outdated: { why: plan.why, reason: outdatedText(plan.why), from, restarted, ...(hint ? { hint } : {}) } };
  }

  /** A database Retake never touched: made sure of (the seed may create it), then kept as its base before its first seed. */
  private async firstBase(ctx: ProviderContext, snap: SnapshotPort, recorded: SnapshotState | undefined): Promise<ResetResult['base']> {
    if (await snap.ensureDatabase(recorded?.owner)) ctx.log('info', `sandbox ${this.env}: database ${snap.target.database} was missing (an interrupted restore): created empty before the seed`);
    ctx.progress?.step('base', `keeping ${describeDatabase(snap.target)} as it is before its first seed`);
    const b = await snap.takeBase();
    const record: BaseState = { database: snap.target.database, owner: b.owner, taken_at: new Date().toISOString(), ms: b.ms };
    ctx.state.provider_state = { ...(ctx.state.provider_state ?? {}), base: record };
    ctx.save();
    ctx.log('info', `sandbox ${this.env}: base of ${describeDatabase(snap.target)} (before its first seed) taken in ${b.ms} ms`);
    return { action: 'taken', ms: b.ms };
  }

  /**
   * The reset itself (lock held, services up). Strategy snapshot: reset-plan.ts decides — a current template is
   * restored; an outdated one (seed, images, env file, firebase_auth, template gone, reseed) is seeded again from the
   * base (else from the outdated template), after restarting the running services; a fresh database gets its base
   * before its first seed; neither base nor template on a database that is not fresh is refused before anything is
   * changed or forgotten (only an interrupted reset's connections repaired and an earlier template name adopted).
   */
  private async resetLocked(ctx: ProviderContext, by: string, opts: { reseed?: boolean } = {}): Promise<ResetResult> {
    const t0 = Date.now();
    const hash = await this.hashOf(ctx);
    // Before anything changes: what the reset empties must be the sandbox's own — the mailbox, and the databases its
    // reset hooks rewrite (they run at every reset; the seed's are checked before the seed runs).
    await checkMailbox(ctx, this.provider);
    await checkSeedDatabases(ctx, this.provider, 'reset hooks');
    const opened = this.strategy === 'snapshot' ? await this.openSnapshot(ctx) : null;
    const snap = opened?.snap ?? null;
    // Hotfix v0.2.5: a Firebase Auth emulator keeps its accounts in memory — saved after the seed, put back below.
    const fa = await FirebaseAuthSnapshot.open(this.sandbox, ctx.paths, (port) => this.addressOf(ctx, port));
    let seed = { steps: 0, ms: 0 };
    let snapshot: ResetResult['snapshot'];
    let base: ResetResult['base'];
    let outdated: ResetResult['outdated'];
    let superseded = 0;
    try {
      const recorded = ctx.state.provider_state?.snapshot as SnapshotState | undefined;
      // Strategy reseed: the seed, always (it resets what it creates by contract).
      let plan: ResetPlan | null = null;
      if (opened && snap) {
        if (await snap.repair()) ctx.log('info', `sandbox ${this.env}: database ${snap.target.database} accepted no connections (an interrupted reset): repaired`);
        await this.adoptEarlierSnapshot(ctx, snap, recorded);
        plan = resetPlan(await this.planInput(ctx, snap, fa, hash, { reseed: opts.reseed }));
        if (plan.kind === 'refuse') throw await this.refusal(ctx, opened.service, plan.why);
        if (plan.kind === 'restore' && recorded) {
          ctx.progress?.step('snapshot', `restoring ${describeDatabase(snap.target)}`);
          const r = await snap.restore(recorded.owner);
          snapshot = { action: 'restored', ms: r.ms, database: snap.target.database };
          ctx.log('info', `sandbox ${this.env}: snapshot of ${describeDatabase(snap.target)} restored in ${r.ms} ms`);
          // The data is back: the pending rollbacks of earlier runs would act on data that is gone.
          superseded = await supersede(this.hookRunner, this.project.dir, this.env, by, ctx.log);
        }
      }
      if (!snapshot) {
        await checkSeedDatabases(ctx, this.provider);
        // Not seeded until the seed succeeds: an interrupted or failed one is run again by the next up.
        if (ctx.state.seed) {
          delete ctx.state.seed;
          ctx.save();
        }
        if (opened && plan && (plan.kind === 'from-base' || plan.kind === 'from-snapshot')) {
          ({ base, outdated } = await this.startOver(ctx, opened, plan, recorded));
        } else if (snap) {
          base = await this.firstBase(ctx, snap, recorded);
        }
        if (fa) {
          // The seed creates its accounts on an empty emulator (an account of an earlier take would collide).
          fa.forget();
          ctx.progress?.step('firebase auth', 'emptying the emulator before the seed');
          await fa.clear();
        }
        seed = await runSeed(ctx, this.provider, { by, log: ctx.log, signal: ctx.signal, running: this.running });
        if (fa) {
          const n = await fa.save(hash);
          ctx.log('info', `sandbox ${this.env}: ${n} account(s) of the Firebase Auth emulator saved after the seed`);
        }
        superseded = await supersede(this.hookRunner, this.project.dir, this.env, by, ctx.log);
        if (snap) {
          if (ctx.signal?.aborted) throw interrupted(`sandbox ${this.env} seed`);
          ctx.progress?.step('snapshot', `taking a snapshot of ${describeDatabase(snap.target)}`);
          const r = await snap.take(hash);
          const state: SnapshotState = { key: snap.target.key, database: snap.target.database, template: snap.target.template, hash, owner: r.owner, taken_at: new Date().toISOString(), ms: r.ms };
          ctx.state.provider_state = { ...(ctx.state.provider_state ?? {}), snapshot: state };
          snapshot = { action: 'taken', ms: r.ms, database: snap.target.database };
          ctx.log('info', `sandbox ${this.env}: snapshot of ${describeDatabase(snap.target)} taken in ${r.ms} ms`);
        }
        ctx.state.seed = { hash, at: new Date().toISOString(), ms: seed.ms };
        delete ctx.state.unseeded_at;
        ctx.save();
      }
    } finally {
      await snap?.close();
    }
    const { mailbox, restarted, firebaseAuth, hooks } = await this.afterData(ctx, by, fa);
    const at = new Date().toISOString();
    const ms = Date.now() - t0;
    const restored = snapshot?.action === 'restored';
    ctx.state.last_reset = { strategy: this.strategy, at, ms, restored, by };
    ctx.save();
    return {
      strategy: this.strategy,
      restored,
      ms,
      hash,
      at,
      seed,
      mailbox,
      ...(snapshot ? { snapshot } : {}),
      ...(base ? { base } : {}),
      ...(outdated ? { outdated } : {}),
      restarted: [...(outdated?.restarted ?? []), ...restarted],
      superseded,
      ...(firebaseAuth ? { firebase_auth: firebaseAuth } : {}),
      hooks,
    };
  }

  /**
   * Start what is not running, wait until healthy, and seed when needed (never seeded, seed changed, a service
   * started) unless `seed: 'never'`.
   */
  async up(opts: SandboxCallOptions & { seed?: 'auto' | 'never'; build?: boolean } = {}): Promise<SandboxUpResult> {
    // The lock first: the state is read once nobody else can change it.
    const lock = this.lock('sandbox up', opts.log ?? quiet);
    try {
      const ctx = this.context(opts);
      return await this.starting(ctx, 'up', async () => {
        // The seed as it was: starting a process service drops it (its in-memory data went with the old process).
        const before = ctx.state.seed;
        const res: SandboxUpResult = await this.provider.up(ctx, { build: opts.build });
        if (opts.seed === 'never') {
          // The product may now be used without its seed: that data is no clean start (reset-plan.ts freshDatabase).
          if (!ctx.state.seed && !ctx.state.unseeded_at) {
            ctx.state.unseeded_at = new Date().toISOString();
            ctx.save();
          }
          return res;
        }
        const hash = await this.hashOf(ctx);
        const why = !before
          ? 'never seeded'
          : before.hash !== hash
            ? 'the seed changed'
            : res.started.length
              ? `${res.started.join(', ')} started`
              : !ctx.state.seed
                ? 'its data is gone'
                : await this.brokenDatabase(ctx);
        if (why) {
          ctx.log('info', `seeding sandbox ${this.env} (${why})`);
          res.reset = await this.resetLocked(ctx, 'sandbox up');
        }
        return res;
      });
    } finally {
      lock.releaseSync();
    }
  }

  /** Strategy snapshot: why its database cannot serve the app (an interrupted reset dropped or blocked it), else null. */
  private async brokenDatabase(ctx: ProviderContext): Promise<string | null> {
    if (this.strategy !== 'snapshot') return null;
    const { snap } = await this.openSnapshot(ctx);
    try {
      return await snap.broken();
    } finally {
      await snap.close();
    }
  }

  /**
   * Stop every service. The data of a process sandbox goes with them, a docker-compose sandbox's stays in its volumes
   * unless `volumes` (then its snapshot goes too): the next up seeds again when it is gone.
   */
  async down(opts: SandboxCallOptions & { volumes?: boolean } = {}): Promise<DownResult> {
    // The lock first: the state is read once nobody else can change it.
    const lock = this.lock('sandbox down', opts.log ?? quiet);
    try {
      const ctx = this.context(opts);
      // A snapshot sandbox's database may outlive --volumes (a bind mount, an external volume): read where it lives
      // first (the services are still up); not known (down already) counts as kept.
      const storage = opts.volumes && this.strategy === 'snapshot' && this.provider.capabilities.snapshots ? await bestEffort(this.dataStorage(ctx), 'not known counts as kept', null) : null;
      const res = await this.provider.down(ctx, { volumes: opts.volumes });
      const kept = opts.volumes === true && this.strategy === 'snapshot' && this.provider.capabilities.snapshots && storage?.kind !== 'volume';
      if (kept && res.dataGone)
        ctx.log(
          'info',
          `sandbox ${this.env}: ${storage ? `its database's data is not in a volume of the sandbox (${storage.kind}${storage.where ? ` ${storage.where}` : ''})` : 'where its database keeps its data is not known (it was not running)'}: its seed is kept as recorded`,
        );
      // The data really went: nothing seeded, reset or used since (reset-plan.ts freshDatabase).
      if (res.dataGone && !kept && (ctx.state.seed || ctx.state.unseeded_at || (opts.volumes && ctx.state.last_reset))) {
        delete ctx.state.seed;
        delete ctx.state.unseeded_at;
        if (opts.volumes) delete ctx.state.last_reset;
        ctx.save();
      }
      return res;
    } finally {
      lock.releaseSync();
    }
  }

  /**
   * Back to the seed. The sandbox must be up (health is checked first; nothing is started). `reseed`: run the seed even
   * when a snapshot could be restored (and take it again) — for seed changes the hash cannot see.
   */
  async reset(opts: SandboxCallOptions & { by?: string; reseed?: boolean } = {}): Promise<ResetResult> {
    // The lock first: the state is read once nobody else can change it.
    const lock = this.lock('sandbox reset', opts.log ?? quiet);
    try {
      const ctx = this.context(opts);
      await this.requireUp(ctx);
      return await this.starting(ctx, 'reset', () => this.resetLocked(ctx, opts.by ?? 'sandbox reset', { reseed: opts.reseed }));
    } finally {
      lock.releaseSync();
    }
  }

  /** Throws SandboxError down unless every service runs and is healthy. */
  private async requireUp(ctx: ProviderContext): Promise<ServiceStatus[]> {
    const services = await this.provider.status(ctx);
    const bad = services.filter((s) => !s.orphan && (s.state === 'stopped' || s.healthy === false));
    if (bad.length) {
      const what = bad.map((s) => (s.state === 'stopped' ? `${s.name} is not running` : `${s.name} is not healthy (${s.health})`)).join(', ');
      throw new SandboxError(`sandbox ${this.env} is not running (${what}): retake sandbox up ${this.project.slug} --env ${this.env}, or run with --sandbox`, 'down');
    }
    return services;
  }

  /**
   * For a run on the sandbox's environment without --sandbox: the sandbox must be up and healthy (SandboxError down
   * otherwise); a live take lock is returned so the caller can warn.
   */
  async checkRunning(opts: SandboxCallOptions = {}): Promise<{ lock?: LockRecord }> {
    const ctx = this.context(opts);
    await this.requireUp(ctx);
    const held = readLock(this.paths.lock);
    return held && lockAlive(held) ? { lock: held } : {};
  }

  /** How the sandbox is now: no lock taken, nothing written. */
  async status(opts: SandboxCallOptions = {}): Promise<SandboxStatus> {
    const notes: string[] = [];
    const ctx = this.context({ ...opts, log: (_l, m) => notes.push(m) });
    const services = await this.provider.status(ctx);
    const declared = services.filter((s) => !s.orphan);
    const running = declared.filter((s) => s.state !== 'stopped');
    const state = running.length === 0 ? 'down' : running.length === declared.length && declared.every((s) => s.healthy !== false && s.state === 'running') ? 'up' : 'partial';
    const held = readLock(this.paths.lock);
    const hash = await this.hashOf(ctx);
    const seed = ctx.state.seed;
    const snapshot = this.strategy === 'snapshot' && this.provider.capabilities.snapshots ? await this.snapshotStatus(ctx, state, hash) : undefined;
    return {
      env: this.env,
      provider: this.sandbox.manifest.provider,
      file: this.sandbox.file,
      state,
      services,
      ...(seed ? { seed: { hash: seed.hash.slice(0, 12), at: seed.at, ms: seed.ms, current: seed.hash === hash } } : {}),
      ...(ctx.state.last_reset ? { last_reset: ctx.state.last_reset } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(ctx.state.accounts_at ? { accounts_at: ctx.state.accounts_at } : {}),
      ...(held && lockAlive(held) ? { lock: held } : {}),
      logs: this.paths.logs,
      notes,
    };
  }

  /**
   * The snapshot as the next reset will find it (reset-plan.ts), read only: nothing repaired or renamed (a template
   * under its earlier name counts as the template), a short connection timeout, and `unknown` — never an error — when
   * the sandbox is down or its Postgres cannot be read.
   */
  private async snapshotStatus(ctx: ProviderContext, state: SandboxStatus['state'], hash: string): Promise<NonNullable<SandboxStatus['snapshot']>> {
    const hasBase = (ctx.state.provider_state?.base as BaseState | undefined) !== undefined;
    if (state === 'down') return { state: 'unknown', base: hasBase, detail: 'sandbox down' };
    let opened: { snap: SnapshotPort; service: string } | null = null;
    try {
      opened = await this.openSnapshot(ctx, { timeoutMs: STATUS_PG_TIMEOUT_MS });
      const fa = await FirebaseAuthSnapshot.open(this.sandbox, ctx.paths, (port) => this.addressOf(ctx, port));
      const input = await this.planInput(ctx, opened.snap, fa, hash, { earlier: true });
      const plan = resetPlan(input);
      const shown = plan.kind === 'restore' ? 'current' : plan.kind === 'first-seed' ? 'none' : 'outdated';
      return { state: shown, ...('why' in plan ? { why: plan.why, reason: outdatedText(plan.why) } : {}), base: input.base, next: plan.kind };
    } catch (e) {
      // Fixed words; the error itself (another project's names, a server's message) apart, as data.
      return { state: 'unknown', base: hasBase, detail: 'its database could not be read', error: errorMessage(e) };
    } finally {
      await opened?.snap.close();
    }
  }

  /**
   * The last `lines` lines of the services' logs (all, or one): the log files of a process sandbox, `docker compose
   * logs` of a docker-compose one (`source` says where they come from).
   */
  async logs(opts: { service?: string; lines?: number } = {}): Promise<SandboxLogs[]> {
    const ctx = this.context({});
    const lines = opts.lines ?? 50;
    if (this.provider.capabilities.logs) {
      const out = await this.provider.logs(ctx, { service: opts.service, lines });
      return out.map((l) => ({ service: l.service, file: '', source: l.source, exists: true, text: l.text }));
    }
    const files = this.provider.logFiles(ctx);
    const picked = opts.service === undefined ? files : files.filter((f) => f.service === opts.service);
    if (opts.service !== undefined && !picked.length) {
      throw new SandboxError(`unknown service "${opts.service}" (sandbox ${this.env}: ${files.map((f) => f.service).join(', ')})`);
    }
    return picked.map((f) => ({ ...f, exists: existsSync(f.file), text: tailLines(f.file, lines) }));
  }

  /** Follow the logs until `signal` aborts (docker-compose; a process sandbox's are files: tail -f them). */
  async followLogs(opts: { service?: string; lines?: number; signal: AbortSignal; write: (line: string) => void }): Promise<void> {
    if (!this.provider.capabilities.followLogs) throw new SandboxError(`sandbox ${this.env}: following logs is for docker-compose sandboxes — tail -f ${shownPath(this.paths.logs)}/<service>.log`);
    await this.provider.followLogs(this.context({}), { service: opts.service, lines: opts.lines ?? 50, signal: opts.signal, write: opts.write });
  }

  /** Cut logs over LOG_CAP_BYTES (kept as `<log>.1`): the services write with O_APPEND, so truncating in place is safe. */
  private trimLogs(ctx: ProviderContext): void {
    for (const { file, service } of this.provider.logFiles(ctx)) {
      try {
        if (statSync(file).size <= LOG_CAP_BYTES) continue;
        copyFileSync(file, `${file}.1`);
        truncateSync(file, 0);
        ctx.log('debug', `log of service ${service} cut at ${LOG_CAP_BYTES / 1024 / 1024} MB (the previous part: ${shownPath(file)}.1)`);
      } catch {
        /* no log yet */
      }
    }
  }

  /**
   * Before a take: the take lock, up (without seeding: the reset follows), health, reset. The lock is held until
   * `release()` — the caller films in between. A failure or an interrupt stops what this call started and releases.
   */
  async prepareTake(opts: SandboxCallOptions & { command?: string } = {}): Promise<Take> {
    const command = opts.command ?? 'run';
    const lock = this.lock(command, opts.log ?? quiet);
    try {
      const ctx = this.context(opts);
      this.trimLogs(ctx);
      const { up, reset } = await this.starting(ctx, 'take', async () => {
        const up = await this.provider.up(ctx);
        return { up, reset: await this.resetLocked(ctx, command) };
      });
      const info: RunSandbox = {
        name: this.env,
        provider: this.sandbox.manifest.provider,
        strategy: reset.strategy,
        restored: reset.restored,
        reset_ms: reset.ms,
        seed_hash: reset.hash.slice(0, 12),
        at: reset.at,
      };
      return { info, up, reset, note: (run) => lock.note(run), release: () => lock.release() };
    } catch (e) {
      lock.releaseSync();
      throw e;
    }
  }

  /** A second Ctrl-C: kill what the current call started — a seed's shell step too —, synchronously (SIGKILL). */
  killStartedSync(): void {
    for (const pgid of this.running) killGroupSync(pgid);
    this.running.clear();
    if (this.ctx) this.provider.killStartedSync(this.ctx);
  }
}
