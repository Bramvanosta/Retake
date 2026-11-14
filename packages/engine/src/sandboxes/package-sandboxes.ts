/**
 * The product's sandboxes: the sandbox package behind the Sandboxes port, with its process and docker-compose providers.
 * The package is loaded through the engine's loader (lazy.ts `sandbox`) on the first call — a command that touches no
 * sandbox never loads it (nor pg) — and `open` is the package's `openSandbox`: the handle is its Sandbox, every call and
 * every refusal (SandboxError, its code and words) the package's, unchanged. Made by the composition roots only
 * (ports.ts enginePorts).
 */
import { sandbox } from '../lazy.js';
import type { Secrets } from '../secrets/secrets.js';
import type { SandboxHandle, Sandboxes } from './sandboxes.js';

type SandboxPackage = Awaited<ReturnType<typeof sandbox>>;

/** The package's Sandbox is a handle of the port, as it is (checked here, where the engine hands it on). */
type Assignable<A extends B, B> = [A, B];
export type SandboxHandleChecks = Assignable<InstanceType<SandboxPackage['Sandbox']>, SandboxHandle>;

/** `secrets`: what the sandboxes' secret references are resolved with (the bag's Secrets port, handed to each sandbox). */
export function packageSandboxes(secrets: Secrets): Sandboxes {
  return {
    open: async (project, env, policy): Promise<SandboxHandle> => (await sandbox()).openSandbox(project, env, policy, (ref) => secrets.resolve(ref)),
    init: async (project, o) => (await sandbox()).initSandbox(project, o),
  };
}
