/**
 * The capture's hooks, as the runner sees them (L7.25, U14): what runs them is handed by the caller (RunOptions.hookRunner:
 * the engine's HookRunner port — the hooks package in the product, an in-memory one in the engine's tests), and every
 * type it names is core's shared hook-run vocabulary (core hook-run.ts: CaptureHookRunner, HookJournal, HookContext,
 * HookResult, ConfirmHook). The runner never loads the hooks package, and keeps no mirror of its types: the hand-written
 * `…Like` interfaces that stood here (checked against @retake/hooks by type asserts) are gone with L7.25 — the engine's
 * port extends the same CaptureHookRunner, and the hooks package's runHooks and Journal satisfy it where the engine
 * wraps them (engine hook-run/package-hooks.ts).
 */
import type { CaptureHookRunner, HookResult } from '@retake/core';
import { RunnerError, errorMessage } from './errors.js';

// The names this package exported for them (its root and its types entry): core's types.
export type { ConfirmHook } from '@retake/core';

/** Why the run's hooks cannot run: none was handed, or the one handed could not load what runs them. */
export const NO_HOOK_RUNNER = 'this scenario has hooks (setup, teardown or hook steps) but no hook runner was handed to the runner (RunOptions.hookRunner)';

/** Load the handed hook runner: a failure is the runner's error, worded as when the runner loaded @retake/hooks itself. */
export async function loadHookRunner(runner: CaptureHookRunner): Promise<void> {
  try {
    await runner.load();
  } catch (e) {
    throw new RunnerError(`this scenario has hooks (setup, teardown or hook steps) but @retake/hooks could not be loaded: ${errorMessage(e)}`);
  }
}

export function hookResultName(r: HookResult, i: number): string {
  return r.name ?? r.description ?? `hook ${i + 1}`;
}

/** A failed hook: not ok, or its status says so (`error` too: a status no core result has, read as before L7.25). */
export function hookResultFailed(r: HookResult): boolean {
  return r.ok === false || r.status === 'failed' || (r.status as string) === 'error';
}
