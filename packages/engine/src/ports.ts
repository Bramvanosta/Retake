/**
 * The engine's ports bag: the adapters a composition root chooses — createEngine (its `ports` option, which the MCP
 * server and the Studio leave out), the jobs worker (`WorkerOptions.ports`), the job process and the CLI
 * (`cli/src/workspace.ts` `cliPorts`). `enginePorts` is the one place their defaults are written: nothing but those
 * roots calls it, nor names `systemClock` or `diskProjectStores` (the import-rules ratchet's `clock-read` and
 * `store-new` checks). Each later port (U6: hooks, reviewer, capture) adds one member.
 */
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import { diskProjectStores } from './store/project-store.js';
import type { ProjectStores } from './store/store.js';

export interface EnginePorts {
  /** What the engine stamps what it writes with (clock.ts). */
  clock: Clock;
  /** What every authored write goes through (store/store.ts). */
  stores: ProjectStores;
}

/** The ports given, the product's adapters for the others: the system's clock and the disk's stores. */
export function enginePorts(given: Partial<EnginePorts> = {}): EnginePorts {
  return { clock: given.clock ?? systemClock, stores: given.stores ?? diskProjectStores };
}
