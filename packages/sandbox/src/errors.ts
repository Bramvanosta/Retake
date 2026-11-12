import { SandboxError } from '@retake/core';

// L7.25: the class is core's (core/src/sandbox-error.ts: one class, `instanceof` holds), re-exported here.
export { SandboxError } from '@retake/core';
export type { SandboxErrorCode } from '@retake/core';

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The abort reason as a SandboxError (code interrupted). */
export function interrupted(what: string): SandboxError {
  return new SandboxError(`${what}: interrupted`, 'interrupted');
}
