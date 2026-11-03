import { destructiveReason } from '@retake/core';
import type { DestructiveOptions, HookStep } from '@retake/core';

/**
 * Destructive-hook detection is shared with scenario validation (core): what validation flags is exactly what
 * the hook runner refuses without `confirm: true`.
 */
export { destructiveReason, psqlDestructiveStatement, shellDestructiveReason, shellWords } from '@retake/core';
export type { DestructiveOptions };

export function isDestructive(hook: HookStep, opts: DestructiveOptions = {}): boolean {
  return destructiveReason(hook, opts) !== null;
}
