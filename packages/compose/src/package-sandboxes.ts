/**
 * The product's sandboxes: the sandbox package behind the Sandboxes port, with its process and docker-compose providers.
 * The package is loaded through the composition package's loader (lazy.ts `sandbox`) on the first call — a command that touches no
 * sandbox never loads it (nor pg) — and `open` is the package's `openSandbox`: the handle is its Sandbox, every call and
 * every refusal (SandboxError, its code and words) the package's, unchanged. Made by the composition package only
 * (ports.ts productPorts).
 */
import type { HookRunner, SandboxHandle, Sandboxes, Secrets } from '@retake/engine/composition';
import { sandbox } from './lazy.js';

type SandboxPackage = Awaited<ReturnType<typeof sandbox>>;

/** The package's Sandbox is a handle of the port, as it is (checked here, where the engine hands it on). */
type Assignable<A extends B, B> = [A, B];
export type SandboxHandleChecks = Assignable<InstanceType<SandboxPackage['Sandbox']>, SandboxHandle>;

/**
 * `secrets`: what the sandboxes' secret references are resolved with (the bag's Secrets port); `hooks`: what runs their
 * seed steps and reset hooks (the bag's HookRunner port). Both handed to each sandbox.
 */
export function packageSandboxes(secrets: Secrets, hooks: HookRunner): Sandboxes {
  return {
    open: async (project, env, policy): Promise<SandboxHandle> => (await sandbox()).openSandbox(project, env, policy, (ref) => secrets.resolve(ref), hooks),
    init: async (project, o) => (await sandbox()).initSandbox(project, o),
    dockerPlaces: async (home) => (await sandbox()).dockerPlaces(home),
  };
}
