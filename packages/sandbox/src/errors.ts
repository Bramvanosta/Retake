import { SandboxError } from '@retake/core/sandbox';

// The class is core's (core/src/sandbox-error.ts: one class, `instanceof` holds), re-exported here.
export { SandboxError } from '@retake/core/sandbox';
export type { SandboxErrorCode } from '@retake/core/sandbox';

/** core's, re-exported for this package's modules. */
export { errorMessage } from '@retake/core/base';

/** The abort reason as a SandboxError (code interrupted). */
export function interrupted(what: string): SandboxError {
  return new SandboxError(`${what}: interrupted`, 'interrupted');
}
