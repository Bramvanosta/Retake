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
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The abort reason as a SandboxError (code interrupted). */
export function interrupted(what: string): SandboxError {
  return new SandboxError(`${what}: interrupted`, 'interrupted');
}
