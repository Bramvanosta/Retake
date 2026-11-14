/**
 * The product's Secrets port (secrets.ts): core io's resolveSecretRef on the environment its composition root read
 * (ports.ts EnginePorts `env`) — `env:` refs from that environment, `keychain:` refs from the system's keychain. Made by
 * the ports bag only (enginePorts).
 */
import { resolveSecretRef } from '@retake/core/io';
import type { EngineEnv } from '../env.js';
import type { Secrets } from './secrets.js';

export function systemSecrets(env: EngineEnv): Secrets {
  return { resolve: (ref) => resolveSecretRef(ref, env) };
}
