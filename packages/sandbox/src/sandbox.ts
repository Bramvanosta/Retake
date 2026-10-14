/**
 * A sandbox of a project (L1.8): `openSandbox(project, env?)` → `up`, `down`, `reset`, `status`, `logs`,
 * `prepareTake` — the API the CLI's `studio sandbox …` / `studio run --sandbox` and L3.1's MCP tools call.
 *
 * - up: start what is not running (health checked, ports owned), then seed when it was never seeded, when the seed
 *   changed (core seedHash) or when it started a service (a restarted process lost its in-memory data); `seed: 'never'`
 *   skips that.
 * - reset: back to the seed — strategy reseed: the seed again; strategy snapshot (docker-compose + Postgres): the
 *   template copy of the seeded database restored, or, when it is missing or stale (seed hash), the seed again and a
 *   new snapshot taken —, the pending rollbacks of the environment superseded as soon as the data is back, then the
 *   mailbox emptied and `reset.restart` services restarted. The mailbox and the seed's databases must be the
 *   sandbox's own (checked before anything changes).
 * - prepareTake: the take lock, up (without seeding), health, reset; the caller films, then releases the lock. The
 *   sandbox stays up afterwards.
 * - up / reset / down / prepareTake hold the take lock (a busy sandbox fails fast); status and logs never lock.
 * An interrupted or failed up / prepareTake stops the services that call started, and only those.
 */
import { copyFileSync, existsSync, statSync, truncateSync } from 'node:fs';
import { isIP } from 'node:net';
import { sandboxNames, seedHash } from '@demo-studio/core';
import type { LoadedProject, LoadedSandbox, RunSandbox, SandboxResetStrategy } from '@demo-studio/core';
import { SandboxError, interrupted } from './errors.js';
import { TakeLock, lockAlive, readLock } from './lock.js';
import type { LockRecord } from './lock.js';
import { sandboxPaths, shownPath } from './paths.js';
import type { SandboxPaths } from './paths.js';
import { ComposeProvider } from './compose.js';
import { ProcessProvider, tailLines } from './process.js';
import type { DownResult, Provider, ProviderContext, SandboxLog, ServiceLogFile, ServiceStatus, UpResult } from './provider.js';
import { checkMailbox, checkSeedDatabases, clearMailbox, runSeed, supersede } from './seed.js';
import { killGroupSync } from './proc.js';
import { PostgresSnapshot, describeDatabase, snapshotTarget } from './snapshot-postgres.js';
import type { SnapshotState } from './snapshot-postgres.js';
import { readState, writeState } from './state.js';
import type { SandboxState } from './state.js';

/** Logs above this size are cut (kept as `<log>.1`) before a take: a sandbox may stay up for days. */
export const LOG_CAP_BYTES = 20 * 1024 * 1024;

export interface SandboxCallOptions {
  signal?: AbortSignal;
  log?: SandboxLog;
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
export function providerFor(sandbox: LoadedSandbox): Provider {
  return sandbox.manifest.provider === 'process' ? new ProcessProvider() : new ComposeProvider();
}

/** The sandbox of environment `env` (default: the first project.yaml declares). */
export function openSandbox(project: LoadedProject, env?: string): Sandbox {
  const names = sandboxNames(project);
  if (!names.length) throw new SandboxError(`project ${project.slug} has no sandbox: add \`sandboxes: {sandbox: sandbox/sandbox.yaml}\` to project.yaml`);
  const name = env ?? names[0];
  const loaded = project.sandboxes?.[name];
  if (!loaded) throw new SandboxError(`${name} is not a sandbox of project ${project.slug} (sandboxes: ${names.join(', ')})`);
  return new Sandbox(project, loaded);
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
  ) {
    this.env = sandbox.env;
    this.paths = sandboxPaths(project.dir, sandbox.env);
    this.provider = providerFor(sandbox);
  }

  /** process | docker-compose. */
  get kind(): LoadedSandbox['manifest']['provider'] {
    return this.sandbox.manifest.provider;
  }

  get strategy(): SandboxResetStrategy {
    return this.sandbox.manifest.reset?.strategy ?? 'reseed';
  }

  /** A provider context on the state as it is on disk now. */
  private context(opts: SandboxCallOptions): ProviderContext {
    const log = opts.log ?? quiet;
    const { state, note } = readState(this.paths.state, this.env, this.sandbox.manifest.provider);
    if (note) log('warn', note);
    const ctx: ProviderContext = {
      project: this.project,
      sandbox: this.sandbox,
      paths: this.paths,
      state,
      save: () => writeState(this.paths.state, ctx.state),
      log,
      signal: opts.signal,
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
    this.provider = providerFor(this.sandbox);
    try {
      const out = await fn();
      if (ctx.signal?.aborted) throw interrupted(`sandbox ${this.env} ${what}`);
      return out;
    } catch (e) {
      const stopped = await this.provider.stopStarted({ ...ctx, signal: undefined }).catch(() => []);
      if (stopped.length) ctx.log('warn', `stopped what this command had started: ${stopped.join(', ')}`);
      throw e;
    }
  }

  /** The seed hash (core seedHash) with the provider's inputs (docker-compose: the services' image ids). */
  private async hashOf(ctx: ProviderContext): Promise<string> {
    return seedHash(this.sandbox, (await this.provider.hashInputs?.(ctx)) ?? []);
  }

  /** The Postgres snapshot of a snapshot reset: its database must be published by the sandbox's own services. */
  private async openSnapshot(ctx: ProviderContext): Promise<PostgresSnapshot> {
    if (!this.provider.publishedBy) {
      throw new SandboxError(`sandbox ${this.env}: snapshot resets need provider docker-compose (the database must belong to the sandbox): use strategy reseed`);
    }
    const target = await snapshotTarget(this.project, this.sandbox);
    await this.provider.publishedBy(ctx, target.port);
    // A host name: on the address Docker publishes the port on, never `localhost` (another container may publish the
    // same port on ::1); an address is used as written.
    const address = isIP(target.host) ? undefined : await this.provider.address?.(ctx, target.port);
    return PostgresSnapshot.open(address ? { ...target, host: address } : target, this.env);
  }

  /**
   * The reset itself (lock held, services up). Strategy snapshot: a valid template (same seed hash in the state and in
   * its comment) is restored; otherwise — first time, seed or images changed, `reseed`, template gone with the
   * volumes — the seed runs and the template is taken again.
   */
  private async resetLocked(ctx: ProviderContext, by: string, opts: { reseed?: boolean } = {}): Promise<ResetResult> {
    const t0 = Date.now();
    const hash = await this.hashOf(ctx);
    // Before anything changes: what the reset empties must be the sandbox's own.
    await checkMailbox(ctx, this.provider);
    const snap = this.strategy === 'snapshot' ? await this.openSnapshot(ctx) : null;
    let seed = { steps: 0, ms: 0 };
    let snapshot: ResetResult['snapshot'];
    let superseded = 0;
    try {
      const recorded = ctx.state.provider_state?.snapshot as SnapshotState | undefined;
      if (snap) {
        if (await snap.repair()) ctx.log('info', `sandbox ${this.env}: database ${snap.target.database} accepted no connections (an interrupted reset): repaired`);
        const valid = !opts.reseed && ctx.state.seed?.hash === hash && recorded?.hash === hash && recorded.database === snap.target.database && (await snap.valid(hash));
        if (valid) {
          const r = await snap.restore(recorded.owner);
          snapshot = { action: 'restored', ms: r.ms, database: snap.target.database };
          ctx.log('info', `sandbox ${this.env}: snapshot of ${describeDatabase(snap.target)} restored in ${r.ms} ms`);
          // The data is back: the pending rollbacks of earlier runs would act on data that is gone.
          superseded = await supersede(this.project.dir, this.env, by, ctx.log);
        }
      }
      if (!snapshot) {
        await checkSeedDatabases(ctx, this.provider);
        // Not seeded until the seed succeeds: an interrupted or failed one is run again by the next up.
        if (ctx.state.seed) {
          delete ctx.state.seed;
          ctx.save();
        }
        if (snap && (await snap.ensureDatabase(recorded?.owner))) ctx.log('info', `sandbox ${this.env}: database ${snap.target.database} was missing (an interrupted restore): created empty before the seed`);
        seed = await runSeed(ctx, this.provider, { by, log: ctx.log, signal: ctx.signal, running: this.running });
        superseded = await supersede(this.project.dir, this.env, by, ctx.log);
        if (snap) {
          if (ctx.signal?.aborted) throw interrupted(`sandbox ${this.env} seed`);
          const r = await snap.take(hash);
          const state: SnapshotState = { key: snap.target.key, database: snap.target.database, template: snap.target.template, hash, owner: r.owner, taken_at: new Date().toISOString(), ms: r.ms };
          ctx.state.provider_state = { ...(ctx.state.provider_state ?? {}), snapshot: state };
          snapshot = { action: 'taken', ms: r.ms, database: snap.target.database };
          ctx.log('info', `sandbox ${this.env}: snapshot of ${describeDatabase(snap.target)} taken in ${r.ms} ms`);
        }
        ctx.state.seed = { hash, at: new Date().toISOString(), ms: seed.ms };
        ctx.save();
      }
    } finally {
      await snap?.close();
    }
    const mailbox = await clearMailbox(this.project, this.sandbox, (port) => this.provider.address?.(ctx, port) ?? Promise.resolve(undefined));
    if (mailbox === 'not-mailpit') ctx.log('info', `sandbox ${this.env}: an http mailbox has no generic way to be emptied — empty it in a seed step`);
    const restarted: string[] = [];
    for (const name of this.sandbox.manifest.reset?.restart ?? []) {
      await this.provider.restart(ctx, name);
      restarted.push(name);
    }
    const at = new Date().toISOString();
    const ms = Date.now() - t0;
    const restored = snapshot?.action === 'restored';
    ctx.state.last_reset = { strategy: this.strategy, at, ms, restored, by };
    ctx.save();
    return { strategy: this.strategy, restored, ms, hash, at, seed, mailbox, ...(snapshot ? { snapshot } : {}), restarted, superseded };
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
        if (opts.seed === 'never') return res;
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
    const snap = await this.openSnapshot(ctx);
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
      const res = await this.provider.down(ctx, { volumes: opts.volumes });
      if (res.dataGone && ctx.state.seed) {
        delete ctx.state.seed;
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
      throw new SandboxError(`sandbox ${this.env} is not running (${what}): studio sandbox up ${this.project.slug} --env ${this.env}, or run with --sandbox`, 'down');
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
    return {
      env: this.env,
      provider: this.sandbox.manifest.provider,
      file: this.sandbox.file,
      state,
      services,
      ...(seed ? { seed: { hash: seed.hash.slice(0, 12), at: seed.at, ms: seed.ms, current: seed.hash === hash } } : {}),
      ...(ctx.state.last_reset ? { last_reset: ctx.state.last_reset } : {}),
      ...(held && lockAlive(held) ? { lock: held } : {}),
      logs: this.paths.logs,
      notes,
    };
  }

  /**
   * The last `lines` lines of the services' logs (all, or one): the log files of a process sandbox, `docker compose
   * logs` of a docker-compose one (`source` says where they come from).
   */
  async logs(opts: { service?: string; lines?: number } = {}): Promise<SandboxLogs[]> {
    const ctx = this.context({});
    const lines = opts.lines ?? 50;
    if (this.provider.logs) {
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
    if (!this.provider.followLogs) throw new SandboxError(`sandbox ${this.env}: following logs is for docker-compose sandboxes — tail -f ${shownPath(this.paths.logs)}/<service>.log`);
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
