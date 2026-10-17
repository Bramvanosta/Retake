/**
 * `studio worker` (hidden): the jobs worker of a workspace in this process — what the MCP server starts in the
 * background (it starts the engine's worker entry directly; this command runs the same code). It writes nothing to
 * stdout: diagnostics go to stderr.
 */
import { resolve } from 'node:path';
import { findWorkspaceRoot } from '@demo-studio/core';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';

export interface WorkerCommandOptions {
  idleExit?: string;
  once?: boolean;
}

export async function workerCommand(_ui: Ui, global: GlobalOptions, opts: WorkerCommandOptions): Promise<ExitCode> {
  let idleExitMs: number | undefined;
  if (opts.idleExit !== undefined) {
    idleExitMs = Number(opts.idleExit);
    if (!Number.isInteger(idleExitMs) || idleExitMs < 0) throw new UsageError(`--idle-exit must be a whole number of milliseconds, got "${opts.idleExit}"`);
  }
  const { runWorker } = await import('@demo-studio/engine');
  const root = global.root ? resolve(global.root) : findWorkspaceRoot();
  const code = await runWorker({ root, ...(idleExitMs !== undefined ? { idleExitMs } : {}), once: opts.once === true });
  return code === 0 ? EXIT.ok : EXIT.failure;
}
