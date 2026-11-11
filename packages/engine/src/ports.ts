/**
 * The engine's ports bag: the adapters a composition root chooses — createEngine (its `ports` option, which the MCP
 * server and the Studio leave out), the jobs worker (`WorkerOptions.ports`), the job process and the CLI
 * (`cli/src/workspace.ts` `cliPorts`). `enginePorts` is the one place their defaults are written: nothing but those
 * roots calls it, nor names `systemClock`, `diskProjectStores`, `packageHookRunner` or `packageReviewer` (the
 * import-rules ratchet's `clock-read`, `store-new` and `loader-use` checks). Each later port (U6: capture) adds one
 * member.
 */
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import { packageHookRunner } from './hook-run/package-hooks.js';
import type { HookRunner } from './hook-run/runner.js';
import { packageReviewer } from './review/review-package.js';
import type { Reviewer } from './review/reviewer.js';
import { diskProjectStores } from './store/project-store.js';
import type { ProjectStores } from './store/store.js';

export interface EnginePorts {
  /** What the engine stamps what it writes with (clock.ts). */
  clock: Clock;
  /** What every authored write goes through (store/store.ts). */
  stores: ProjectStores;
  /** What runs hooks outside a capture and replays their journals' rollbacks (hook-run/runner.ts). */
  hooks: HookRunner;
  /** What reviews a render and draws the frames and thumbnails the façade serves (review/reviewer.ts). */
  reviewer: Reviewer;
}

/**
 * The ports given, the product's adapters for the others: the system's clock, the disk's stores, the hooks package and
 * the review package (neither loaded before a member's first call).
 */
export function enginePorts(given: Partial<EnginePorts> = {}): EnginePorts {
  return {
    clock: given.clock ?? systemClock,
    stores: given.stores ?? diskProjectStores,
    hooks: given.hooks ?? packageHookRunner(),
    reviewer: given.reviewer ?? packageReviewer(),
  };
}
