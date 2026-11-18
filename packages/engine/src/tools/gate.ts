/**
 * Which needs of the Tools are missing now (the queue's waiting state): what the job queue derives a queued
 * job's `yield: {cause: 'tools'}` from, and what the worker's pick skips (jobs/pick.ts). Read cheaply (core toolState
 * without its walk: the stamp and the markers), at most once a second per gate.
 *
 * - In a checkout nothing is ever missing (Playwright's cache and node_modules, as before).
 * - `browser` is missing while the browser is not ready, unless `$RETAKE_CHROMIUM` names another one.
 * - `render` is missing while the render browser is not ready (unless `$RETAKE_CHROMIUM_HEADLESS_SHELL` names
 *   another) or the compositor is not.
 * - An app whose bundle.json lists no valid Tools is damaged: both are missing (its jobs wait; doctor says why).
 */
import { bundleInfoOrNull, bundleTools, toolState, toolsDir } from '@retake/core/io';
import type { BundleInfo, ToolEntry, ToolId, ToolNeed } from '@retake/core/io';
import type { EngineEnv } from '../env.js';
import type { ToolsGate } from '../jobs/job-queue.js';

export type { ToolsGate } from '../jobs/job-queue.js';

const NONE: ReadonlySet<ToolNeed> = new Set();
const BOTH: ReadonlySet<ToolNeed> = new Set(['browser', 'render']);

/** The needs missing for `entries` under `env`'s home (see the module comment). */
export function missingNeeds(env: EngineEnv, bundle: BundleInfo | null): ReadonlySet<ToolNeed> {
  if (!bundle) return NONE;
  let entries: ToolEntry[];
  try {
    entries = bundleTools(bundle);
  } catch {
    return BOTH;
  }
  const dir = toolsDir(env as NodeJS.ProcessEnv);
  const ready = (id: ToolId) => toolState(entries.find((e) => e.id === id)!, dir, { walk: false }).state === 'ready';
  const out = new Set<ToolNeed>();
  if (!env.RETAKE_CHROMIUM?.trim() && !ready('browser')) out.add('browser');
  if ((!env.RETAKE_CHROMIUM_HEADLESS_SHELL?.trim() && !ready('render-browser')) || !ready('compositor')) out.add('render');
  return out;
}

/**
 * A gate on `env`'s home and this engine's bundle (`bundle`: tests hand theirs), read again at most every `ttlMs`
 * (a list of jobs derives each one: the files are read once for all).
 */
export function toolsGate(env: EngineEnv, bundle: () => BundleInfo | null = bundleInfoOrNull, ttlMs = 1_000): ToolsGate {
  let at = -Infinity;
  let last: ReadonlySet<ToolNeed> = NONE;
  return () => {
    const now = performance.now();
    if (now - at >= ttlMs) {
      last = missingNeeds(env, bundle());
      at = now;
    }
    return last;
  };
}
