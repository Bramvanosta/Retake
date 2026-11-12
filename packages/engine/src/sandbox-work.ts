/**
 * The sandbox use cases (L7.28, U8c): what `retake sandbox init | up | down | reset | status | logs`, the `sandbox_up` /
 * `sandbox_reset` jobs and the MCP `sandbox_status` answer do with a project's sandbox, over the Sandboxes port
 * (sandboxes/sandboxes.ts). Shared: a lock-holding call under the caller's interrupt port (the first signal aborts what
 * the call started, a later one kills it synchronously: `killStartedSync`), the seed run journalled as the caller
 * (`recordAs`), a status with its environment's pages, the scaffold reloaded as written. Each caller keeps its own
 * trust and its own words: a call's options are handed to the sandbox key for key (the CLI's progress, `seed`, `build`,
 * `reseed`; the job's `seedTrust` taken at submit — never one the caller did not give), and a refusal is the sandbox's
 * SandboxError, which the CLI turns into its usage errors and the jobs into an EngineError.
 */
import { resolveEnvironment } from '@retake/core/environment';
import { sandboxNames } from '@retake/core/sandbox';
import type { LoadedProject, ValidationIssue } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import { loadProject } from '@retake/core/io';
import type { DownResult, InitSandboxOptions, InitSandboxResult, ResetResult, SandboxLog, SandboxLogs, SandboxProgress, SandboxStatus, SandboxUpResult, SeedTrust } from '@retake/sandbox/types';
import type { ENGINE_TRUST } from './caller.js';
import { EngineError } from './errors.js';
import type { InterruptPort } from './interrupts.js';
import type { SandboxHandle, Sandboxes } from './sandboxes/sandboxes.js';
import { hookRunRecorder } from './store/journal.js';
import type { JournalAs } from './store/journal.js';

/** What a lock-holding call (up, reset, down) takes besides its own options. */
export interface SandboxHeldOptions {
  /** The caller's interrupts (the CLI: its Ctrl-C handler; a job: the worker's signal rule). */
  interrupts: InterruptPort;
  log: SandboxLog;
}

/**
 * Who seeds, as hooks-work.ts's `Protected` (L7.23): the person (trust `author`: their own seed steps run as a terminal
 * runs them, no seed trust) or the engine (trust `mcp`, a job: the seed trust of the engine's trust, with the approvals
 * taken at submit). The type cannot forget it; seedingCheck refuses it at run time too.
 */
export type SeedTrusted = { trust: 'author'; seedTrust?: undefined } | { trust: typeof ENGINE_TRUST; seedTrust: SeedTrust & { trust: typeof ENGINE_TRUST } };

/** up / reset: the seed run is journalled as `recordAs` (the caller and its clock). */
export type SandboxSeedingOptions = SandboxHeldOptions &
  SeedTrusted & {
    recordAs: JournalAs;
    progress?: SandboxProgress;
  };

export type SandboxUpWorkOptions = SandboxSeedingOptions & {
  seed?: 'auto' | 'never';
  build?: boolean;
};

export type SandboxResetWorkOptions = SandboxSeedingOptions & {
  reseed?: boolean;
};

/** A trust-`mcp` up / reset without the engine's seed trust is a bug of its caller: refused before the sandbox is touched. */
function seedingCheck(o: { trust: string; seedTrust?: SeedTrust }, work: string): void {
  if (o.trust === 'mcp' && o.seedTrust?.trust !== 'mcp') throw new EngineError('internal', `${work} with trust mcp needs the seed trust of the engine (trust mcp, the approvals taken at submit)`);
}

export interface SandboxDownWorkOptions extends SandboxHeldOptions {
  volumes?: boolean;
}

/** What the first interrupt of a lock-holding call says. */
export const SANDBOX_INTERRUPT_MESSAGE = 'interrupted: stopping what this command started…';

/** Run a lock-holding call under the caller's interrupts: the first aborts it, a later one kills what it started. */
async function held<T>(interrupts: InterruptPort, sb: SandboxHandle, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = await interrupts.open({ message: SANDBOX_INTERRUPT_MESSAGE, onQuitSync: () => sb.killStartedSync() });
  try {
    return await fn(stop.signal);
  } finally {
    stop.dispose();
  }
}

/** The call's own options, key for key (a key the caller gave with `undefined` stays: the sandbox reads its default). */
function own<T extends object, K extends keyof T>(o: T, ...drop: K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !(drop as PropertyKey[]).includes(k))) as Omit<T, K>;
}

function recorder(project: LoadedProject, as: JournalAs) {
  return hookRunRecorder(project.root, as, { project: project.slug });
}

export interface SandboxInitView {
  result: InitSandboxResult;
  /** The new sandbox's issues, as the project reloaded from what was written reads them. */
  warnings: ValidationIssue[];
  /** The new sandbox is the reloaded project's default one (no `--env` needed). */
  isDefault: boolean;
}

export const sandboxWork = {
  /** The sandbox of `env` (default: the project's first); a SandboxError when there is none (each caller words it). */
  open(sandboxes: Sandboxes, project: LoadedProject, env: string | undefined, policy: WorkPolicy): Promise<SandboxHandle> {
    return sandboxes.open(project, env, policy);
  },

  /** Scaffold a docker-compose sandbox, then read the project back as written (it must load: its warnings). */
  async init(sandboxes: Sandboxes, project: LoadedProject, o: InitSandboxOptions): Promise<SandboxInitView> {
    const result = await sandboxes.init(project, o);
    const reloaded = await loadProject(project.dir);
    return { result, warnings: reloaded.sandboxes?.[result.env]?.issues ?? [], isDefault: sandboxNames(reloaded)[0] === result.env };
  },

  async up(project: LoadedProject, sb: SandboxHandle, o: SandboxUpWorkOptions): Promise<SandboxUpResult> {
    seedingCheck(o, 'sandboxWork.up');
    const call = own(o, 'interrupts', 'recordAs', 'trust');
    // The scope's signal and the recorder last: nothing the caller hands on replaces them.
    return held(o.interrupts, sb, (signal) => sb.up({ ...call, signal, recordSeedRun: recorder(project, o.recordAs) }));
  },

  async reset(project: LoadedProject, sb: SandboxHandle, o: SandboxResetWorkOptions): Promise<ResetResult> {
    seedingCheck(o, 'sandboxWork.reset');
    const call = own(o, 'interrupts', 'recordAs', 'trust');
    return held(o.interrupts, sb, (signal) => sb.reset({ ...call, signal, recordSeedRun: recorder(project, o.recordAs) }));
  },

  down(sb: SandboxHandle, o: SandboxDownWorkOptions): Promise<DownResult> {
    const call = own(o, 'interrupts');
    return held(o.interrupts, sb, (signal) => sb.down({ ...call, signal }));
  },

  /** How it is now (no lock, nothing written), with the pages of its environment. */
  async status(project: LoadedProject, sb: SandboxHandle): Promise<{ status: SandboxStatus; pages: Record<string, string> }> {
    const status = await sb.status();
    return { status, pages: resolveEnvironment(project, sb.env).pages };
  },

  /** The last lines of the services' logs (all, or one: an unknown service is a SandboxError). */
  logs(sb: SandboxHandle, o: { service?: string; lines?: number }): Promise<SandboxLogs[]> {
    return sb.logs(o);
  },

  /** Follow the logs until the caller's interrupt (capability `followLogs`: the caller checks it first, in its words). */
  async followLogs(sb: SandboxHandle, o: { service?: string; lines?: number; interrupts: InterruptPort; write: (line: string) => void }): Promise<void> {
    const stop = await o.interrupts.open({ message: 'stopped following the logs' });
    try {
      await sb.followLogs({ service: o.service, lines: o.lines, signal: stop.signal, write: o.write });
    } finally {
      stop.dispose();
    }
  },
};
