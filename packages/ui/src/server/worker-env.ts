/**
 * The environment of a jobs worker the Studio starts (L4.2, critique B5): engine cleanWorkerEnv — the same cleaner every
 * client but the CLI uses (review A #3), so a worker an MCP client started serves the Studio's jobs in no richer an
 * environment. See engine jobs/worker-env.ts for what is dropped and what stays.
 */
import { existsSync } from 'node:fs';
import { cleanWorkerEnv } from '@demo-studio/engine';

export function studioWorkerEnv(env: NodeJS.ProcessEnv, root: string, node: string = process.execPath, exists: (p: string) => boolean = existsSync): NodeJS.ProcessEnv {
  return cleanWorkerEnv(env, root, { node, exists });
}
