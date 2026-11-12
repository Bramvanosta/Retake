/**
 * The error of a sandbox's work (L1.8; L7.25: from @retake/sandbox's errors.ts, which re-exports it — one class, so
 * `instanceof` holds wherever it is imported from). Pure: the take lock of core's io side (`io/lock.ts`) and the
 * engine's in-memory sandboxes throw it too.
 */
import { GUIDE, sandboxErrorKind } from './error-kind.js';
import type { ErrorKind } from './error-kind.js';

/**
 * What went wrong with a sandbox, for callers that act on it (the CLI's exit code, L3.1's MCP tools):
 * - busy: another command holds the sandbox's take lock;
 * - down: the sandbox is not running (a run on its environment without --sandbox);
 * - port: a port of the sandbox is used by another program;
 * - unhealthy: a service did not become healthy (or exited);
 * - seed: a seed step failed;
 * - interrupted: Ctrl-C / SIGTERM (what this call started was stopped);
 * - failed: anything else.
 */
export type SandboxErrorCode = 'busy' | 'down' | 'port' | 'unhealthy' | 'seed' | 'interrupted' | 'failed';

/** A sandbox command failed; the message is written for the user (no stack trace needed). */
export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: SandboxErrorCode = 'failed',
  ) {
    super(message);
    this.name = 'SandboxError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return sandboxErrorKind(this.code, this.message, 'internal');
  }

  get errorDocs(): string {
    return GUIDE.sandbox;
  }
}
