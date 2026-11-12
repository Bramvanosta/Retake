/**
 * An in-memory Sandboxes port (L7.25): sandboxes with no process, container, database or file — for the engine's tests
 * (the sandbox jobs, a run's take, a sandbox environment's check) and the port's contract suite (test/sandbox-contract.ts),
 * which runs it beside the sandbox package. What it keeps, per project folder and environment: which declared services
 * run, the seed (its hash: core seedHash, the provider's inputs none), the last reset, the take lock, a log line per
 * start. What it answers is the package's, in its words: the refusals (no sandbox, not a sandbox of the project, busy,
 * not running, an unknown service, logs followed on a process sandbox) are core's SandboxError with the same codes, a
 * provider's capabilities follow its kind. Not modelled: health (a running service is healthy), ports, a seed's steps
 * (none runs or is recorded: `recordSeedRun` is never called), the mailbox (cleared when there is one), a
 * docker-compose sandbox's image ids, a call's progress lines. Its stamps come from its clock.
 */
import { relativeInside } from '@retake/core/base';
import { sandboxPaths, serviceLog } from '@retake/core/project';
import { SandboxError, sandboxNames } from '@retake/core/sandbox';
import type { LoadedProject, LoadedSandbox, SandboxResetStrategy } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { SandboxPaths } from '@retake/core/project';
import { describeLock, seedHash } from '@retake/core/io';
import type { LockRecord } from '@retake/core/io';
import type { DownResult, InitSandboxOptions, InitSandboxResult, ProviderCapabilities, ResetResult, SandboxCallOptions, SandboxLogs, SandboxStatus, SandboxUpResult, ServiceStatus, Take, UpResult } from '@retake/sandbox/types';
import { ManualClock, stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import type { SandboxHandle, Sandboxes } from './sandboxes.js';

/** The capabilities of each provider kind (the sandbox package's PROCESS_CAPABILITIES / COMPOSE_CAPABILITIES; the contract compares them). */
const CAPABILITIES: Record<LoadedSandbox['manifest']['provider'], Readonly<ProviderCapabilities>> = {
  process: Object.freeze({ exec: false, logs: false, followLogs: false, snapshots: false, address: false, hashInputs: false, build: false, volumes: false }),
  'docker-compose': Object.freeze({ exec: true, logs: true, followLogs: true, snapshots: true, address: true, hashInputs: true, build: true, volumes: true }),
};

interface MemorySandboxState {
  running: Set<string>;
  seed?: { hash: string; at: string; ms: number };
  last_reset?: { strategy: SandboxResetStrategy; at: string; ms: number; restored: boolean; by: string };
  lock?: LockRecord;
  logs: Map<string, string[]>;
}

/** One call of the port, as the tests read them. */
export interface MemorySandboxCall {
  op: 'open' | 'init' | 'up' | 'down' | 'reset' | 'status' | 'checkRunning' | 'logs' | 'followLogs' | 'prepareTake' | 'killStartedSync' | 'release';
  env?: string;
  opts?: Record<string, unknown>;
}

export interface MemorySandboxesOptions {
  /** What the seed's, the reset's and the lock's stamps read (default a manual clock at 2026-11-12T12:00:00Z). */
  clock?: Clock;
}

export class MemorySandboxes implements Sandboxes {
  readonly calls: MemorySandboxCall[] = [];
  readonly #states = new Map<string, MemorySandboxState>();
  readonly #clock: Clock;

  constructor(o: MemorySandboxesOptions = {}) {
    this.#clock = o.clock ?? new ManualClock('2026-11-12T12:00:00.000Z');
  }

  async open(project: LoadedProject, env: string | undefined, _policy: WorkPolicy): Promise<SandboxHandle> {
    this.calls.push({ op: 'open', ...(env !== undefined ? { env } : {}) });
    const names = sandboxNames(project);
    if (!names.length) throw new SandboxError(`project ${project.slug} has no sandbox: add \`sandboxes: {sandbox: sandbox/sandbox.yaml}\` to project.yaml`);
    const name = env ?? names[0];
    const loaded = project.sandboxes?.[name];
    if (!loaded) throw new SandboxError(`${name} is not a sandbox of project ${project.slug} (sandboxes: ${names.join(', ')})`);
    const key = `${project.dir}\0${loaded.env}`;
    let state = this.#states.get(key);
    if (!state) this.#states.set(key, (state = { running: new Set(), logs: new Map() }));
    return new MemorySandbox(project, loaded, state, this.#clock, this.calls);
  }

  /** Not modelled: a scaffold writes the package's files (the sandbox package's own tests and the CLI's hold it). */
  async init(_project: LoadedProject, o: InitSandboxOptions): Promise<InitSandboxResult> {
    this.calls.push({ op: 'init', ...(o.env !== undefined ? { env: o.env } : {}) });
    throw new SandboxError('the in-memory sandboxes write no scaffold: use the sandbox package (packageSandboxes) to init one');
  }
}

class MemorySandbox implements SandboxHandle {
  readonly env: string;
  readonly paths: SandboxPaths;
  readonly #state: MemorySandboxState;
  readonly #clock: Clock;
  readonly #calls: MemorySandboxCall[];

  constructor(
    readonly project: LoadedProject,
    readonly sandbox: LoadedSandbox,
    state: MemorySandboxState,
    clock: Clock,
    calls: MemorySandboxCall[],
  ) {
    this.env = sandbox.env;
    this.paths = sandboxPaths(project.dir, sandbox.env);
    this.#state = state;
    this.#clock = clock;
    this.#calls = calls;
  }

  get kind(): LoadedSandbox['manifest']['provider'] {
    return this.sandbox.manifest.provider;
  }

  get strategy(): SandboxResetStrategy {
    return this.sandbox.manifest.reset?.strategy ?? 'reseed';
  }

  get capabilities(): Readonly<ProviderCapabilities> {
    return CAPABILITIES[this.kind];
  }

  /** The declared services, in sandbox.yaml's order. */
  private get services(): string[] {
    return Object.keys(this.sandbox.manifest.services);
  }

  private call(op: MemorySandboxCall['op'], opts?: object): void {
    const shown = opts ? Object.fromEntries(Object.entries(opts).filter(([k, v]) => v !== undefined && typeof v !== 'function' && k !== 'signal' && k !== 'progress' && k !== 'seedTrust')) : undefined;
    this.#calls.push({ op, env: this.env, ...(shown && Object.keys(shown).length ? { opts: shown } : {}) });
  }

  /** The take lock, as the package's TakeLock refuses a held one (busy, naming the holder). */
  private lock(command: string): () => void {
    const held = this.#state.lock;
    if (held) throw new SandboxError(`sandbox ${this.env} is in use: ${describeLock(held)} — wait for it (retake sandbox status shows it)`, 'busy');
    const rec: LockRecord = { pid: process.pid, command, since: stampOf(this.#clock) };
    this.#state.lock = rec;
    return () => {
      if (this.#state.lock === rec) delete this.#state.lock;
    };
  }

  private interruptedIf(signal: AbortSignal | undefined, what: string, started: readonly string[]): void {
    if (!signal?.aborted) return;
    for (const s of started) this.#state.running.delete(s);
    throw new SandboxError(`sandbox ${this.env} ${what}: interrupted`, 'interrupted');
  }

  private start(): UpResult {
    const started = this.services.filter((s) => !this.#state.running.has(s));
    const kept = this.services.filter((s) => this.#state.running.has(s));
    for (const s of started) {
      this.#state.running.add(s);
      this.#state.logs.set(s, [...(this.#state.logs.get(s) ?? []), `${s} started`]);
    }
    return { started, kept, changed: [], ms: 0 };
  }

  private hash(): Promise<string> {
    return seedHash(this.sandbox, []);
  }

  private async resetLocked(by: string, reseed = false): Promise<ResetResult> {
    const m = this.sandbox.manifest;
    const hash = await this.hash();
    const at = stampOf(this.#clock);
    const database = m.reset?.snapshot?.database ?? Object.keys(m.databases ?? {})[0] ?? 'database';
    const restored = this.strategy === 'snapshot' && !reseed && this.#state.seed?.hash === hash;
    const seed = restored ? { steps: 0, ms: 0 } : { steps: (m.seed ?? []).length, ms: 0 };
    if (!restored) this.#state.seed = { hash, at, ms: 0 };
    this.#state.last_reset = { strategy: this.strategy, at, ms: 0, restored, by };
    return {
      strategy: this.strategy,
      restored,
      ms: 0,
      hash,
      at,
      seed,
      mailbox: m.mailbox ? 'cleared' : 'none',
      ...(this.strategy === 'snapshot' ? { snapshot: { action: restored ? ('restored' as const) : ('taken' as const), ms: 0, database } } : {}),
      restarted: [...(m.reset?.restart ?? [])],
      superseded: 0,
      hooks: { steps: (m.reset?.hooks ?? []).length, ms: 0 },
    };
  }

  /** The package's refusal of a sandbox that is not up (code `down`). */
  private requireUp(): void {
    const stopped = this.services.filter((s) => !this.#state.running.has(s));
    if (stopped.length) {
      throw new SandboxError(`sandbox ${this.env} is not running (${stopped.map((s) => `${s} is not running`).join(', ')}): retake sandbox up ${this.project.slug} --env ${this.env}, or run with --sandbox`, 'down');
    }
  }

  async up(o: SandboxCallOptions & { seed?: 'auto' | 'never'; build?: boolean } = {}): Promise<SandboxUpResult> {
    this.call('up', o);
    const release = this.lock('sandbox up');
    try {
      const before = this.#state.seed;
      // As the process provider does before each service it starts: a signal already aborted starts nothing.
      if (o.signal?.aborted) throw new SandboxError(`sandbox ${this.env}: interrupted`, 'interrupted');
      const res: SandboxUpResult = this.start();
      this.interruptedIf(o.signal, 'up', res.started);
      if (o.seed === 'never') return res;
      const hash = await this.hash();
      const why = !before ? 'never seeded' : before.hash !== hash ? 'the seed changed' : res.started.length ? `${res.started.join(', ')} started` : !this.#state.seed ? 'its data is gone' : null;
      if (why) {
        o.log?.('info', `seeding sandbox ${this.env} (${why})`);
        res.reset = await this.resetLocked('sandbox up');
      }
      return res;
    } finally {
      release();
    }
  }

  async down(o: SandboxCallOptions & { volumes?: boolean } = {}): Promise<DownResult> {
    this.call('down', o);
    const release = this.lock('sandbox down');
    try {
      const stopped = this.services.filter((s) => this.#state.running.has(s)).reverse();
      this.#state.running.clear();
      const dataGone = this.kind === 'process' || o.volumes === true;
      if (dataGone) delete this.#state.seed;
      return { stopped, dataGone };
    } finally {
      release();
    }
  }

  async reset(o: SandboxCallOptions & { by?: string; reseed?: boolean } = {}): Promise<ResetResult> {
    this.call('reset', o);
    const release = this.lock('sandbox reset');
    try {
      this.requireUp();
      const res = await this.resetLocked(o.by ?? 'sandbox reset', o.reseed === true);
      this.interruptedIf(o.signal, 'reset', []);
      return res;
    } finally {
      release();
    }
  }

  async status(o: SandboxCallOptions = {}): Promise<SandboxStatus> {
    this.call('status', o);
    const services: ServiceStatus[] = this.services.map((name) => (this.#state.running.has(name) ? { name, state: 'running', health: 'ok', healthy: true } : { name, state: 'stopped' }));
    const running = services.filter((s) => s.state !== 'stopped').length;
    const seed = this.#state.seed;
    const hash = await this.hash();
    return {
      env: this.env,
      provider: this.kind,
      file: this.sandbox.file,
      state: running === 0 ? 'down' : running === services.length ? 'up' : 'partial',
      services,
      ...(seed ? { seed: { hash: seed.hash.slice(0, 12), at: seed.at, ms: seed.ms, current: seed.hash === hash } } : {}),
      ...(this.#state.last_reset ? { last_reset: this.#state.last_reset } : {}),
      ...(this.#state.lock ? { lock: this.#state.lock } : {}),
      logs: this.paths.logs,
      notes: [],
    };
  }

  async checkRunning(o: SandboxCallOptions = {}): Promise<{ lock?: LockRecord }> {
    this.call('checkRunning', o);
    this.requireUp();
    return this.#state.lock ? { lock: this.#state.lock } : {};
  }

  async logs(o: { service?: string; lines?: number } = {}): Promise<SandboxLogs[]> {
    this.call('logs', o);
    const lines = o.lines ?? 50;
    const picked = o.service === undefined ? this.services : this.services.filter((s) => s === o.service);
    if (o.service !== undefined && !picked.length) throw new SandboxError(`unknown service "${o.service}" (sandbox ${this.env}: ${this.services.join(', ')})`);
    return picked.map((service) => {
      const all = this.#state.logs.get(service);
      const text = all ? `${all.slice(-lines).join('\n')}\n` : '';
      return this.capabilities.logs ? { service, file: '', source: `memory ${this.env}`, exists: true, text } : { service, file: serviceLog(this.paths, service), exists: all !== undefined, text };
    });
  }

  async followLogs(o: { service?: string; lines?: number; signal: AbortSignal; write: (line: string) => void }): Promise<void> {
    this.call('followLogs', { service: o.service, lines: o.lines });
    if (!this.capabilities.followLogs) {
      const shown = relativeInside(this.paths.logs, process.cwd(), { self: false, dotDotPrefix: true }) ?? this.paths.logs;
      throw new SandboxError(`sandbox ${this.env}: following logs is for docker-compose sandboxes — tail -f ${shown}/<service>.log`);
    }
    for (const l of await this.logs({ service: o.service, lines: o.lines })) for (const line of l.text.split('\n').filter(Boolean)) o.write(line);
    if (o.signal.aborted) return;
    await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  async prepareTake(o: SandboxCallOptions & { command?: string } = {}): Promise<Take> {
    this.call('prepareTake', o);
    const command = o.command ?? 'run';
    const release = this.lock(command);
    try {
      const up = this.start();
      const reset = await this.resetLocked(command);
      this.interruptedIf(o.signal, 'take', up.started);
      const held = this.#state.lock!;
      return {
        info: { name: this.env, provider: this.kind, strategy: reset.strategy, restored: reset.restored, reset_ms: reset.ms, seed_hash: reset.hash.slice(0, 12), at: reset.at },
        up,
        reset,
        note: (run) => {
          if (this.#state.lock === held) this.#state.lock = { ...held, run };
        },
        release: async () => {
          this.#calls.push({ op: 'release', env: this.env });
          if (this.#state.lock?.since === held.since && this.#state.lock.pid === held.pid) delete this.#state.lock;
        },
      };
    } catch (e) {
      release();
      throw e;
    }
  }

  killStartedSync(): void {
    this.#calls.push({ op: 'killStartedSync', env: this.env });
  }
}
