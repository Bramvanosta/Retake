import type { HookStep, LoadedProject, ResolvedEnvironment } from '@demo-studio/core';
import { RunnerError, errorMessage } from './errors.js';

/** The part of @demo-studio/hooks the runner uses (docs/DESIGN.md §2). */
export interface HookContextLike {
  project: LoadedProject;
  env: ResolvedEnvironment;
  vars: Record<string, string>;
  runId?: string;
  dryRun?: boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  evalInPage?: (pageKey: string | undefined, code: string) => Promise<unknown>;
  saved: Record<string, unknown>;
}

export interface HookResultLike {
  name?: string;
  description?: string;
  ok?: boolean;
  status?: string;
  error?: string;
  message?: string;
  /** The hook was `optional: true` (its failure did not stop the phase). */
  optional?: boolean;
}

export interface JournalLike {
  pending(): unknown[];
  rollbackAll(ctx: HookContextLike): Promise<HookResultLike[]>;
}

export interface HooksModule {
  runHooks(
    hooks: HookStep[],
    ctx: HookContextLike,
    opts: { phase: 'setup' | 'teardown' | 'reset'; journal: JournalLike },
  ): Promise<{ ok: boolean; results: HookResultLike[] }>;
  Journal: { open(file: string): Promise<JournalLike> };
}

/** Loaded on demand: scenarios without hooks never touch the hooks package (or its pg dependency). */
export async function loadHooksModule(): Promise<HooksModule> {
  const specifier = '@demo-studio/hooks';
  try {
    const mod = (await import(specifier)) as Partial<HooksModule>;
    if (typeof mod.runHooks !== 'function' || typeof mod.Journal?.open !== 'function') {
      throw new Error('it does not export runHooks and Journal');
    }
    return mod as HooksModule;
  } catch (e) {
    throw new RunnerError(`this scenario has setup/teardown hooks but @demo-studio/hooks could not be loaded: ${errorMessage(e)}`);
  }
}

export function hookResultName(r: HookResultLike, i: number): string {
  return r.name ?? r.description ?? `hook ${i + 1}`;
}

export function hookResultFailed(r: HookResultLike): boolean {
  return r.ok === false || r.status === 'failed' || r.status === 'error';
}
